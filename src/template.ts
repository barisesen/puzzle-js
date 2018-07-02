import {FragmentStorefront} from "./fragment";
import cheerio from "cheerio";
import {TemplateCompiler} from "./templateCompiler";
import {
  CHEERIO_CONFIGURATION,
  CONTENT_NOT_FOUND_ERROR,
  NON_SELF_CLOSING_TAGS,
  PUZZLE_DEBUGGER_LINK,
  TEMPLATE_FRAGMENT_TAG_NAME
} from "./config";
import {
  FragmentModel,
  IChunkedReplacementSet,
  ICookieMap,
  IFragmentContentResponse, IFragmentEndpointHandler,
  IPageDependentGateways,
  IReplaceAsset,
  IReplaceAssetSet,
  IReplaceItem,
  IReplaceSet, IWaitedResponseFirstFlush, IWrappingJsAsset
} from "./types";
import {
  CONTENT_REPLACE_SCRIPT, DEFAULT_MAIN_PARTIAL,
  EVENTS,
  HTTP_METHODS, HTTP_STATUS_CODE,
  REPLACE_ITEM_TYPE,
  RESOURCE_INJECT_TYPE, RESOURCE_JS_EXECUTE_TYPE,
  RESOURCE_LOCATION,
  RESOURCE_TYPE
} from "./enums";
import ResourceFactory from "./resourceFactory";
import CleanCSS from "clean-css";
import md5 from "md5";
import {isDebug, pubsub} from "./util";
import {TemplateClass} from "./templateClass";
import {ERROR_CODES, PuzzleError} from "./errors";
import {benchmark} from "./decorators";
import {Logger} from "./logger";
import {container, TYPES} from "./base";

const logger = <Logger>container.get(TYPES.Logger);


export class Template {
  dom: CheerioStatic;
  fragments: { [name: string]: FragmentStorefront } = {};
  pageClass: TemplateClass = new TemplateClass();

  constructor(public rawHtml: string, private name?: string) {
    this.load();
    this.bindPageClass();
    this.pageClass._onCreate();
  }

  /**
   * Loads html template into Cheerio instance
   */
  public load(): void {
    const templateMatch = TemplateCompiler.TEMPLATE_CONTENT_REGEX.exec(this.rawHtml);

    if (templateMatch) {
      this.dom = cheerio.load(templateMatch[1], CHEERIO_CONFIGURATION);
    } else {
      throw new PuzzleError(ERROR_CODES.TEMPLATE_NOT_FOUND);
    }
  }

  /**
   * Returns fragment dependencies
   * @returns {IPageDependentGateways}
   */
  @benchmark(isDebug(), logger.info)
  getDependencies() {
    let primaryName: string | null;

    return this.dom(TEMPLATE_FRAGMENT_TAG_NAME).toArray().reduce((dependencyList: IPageDependentGateways, fragment: CheerioElement) => {
      if (!dependencyList.gateways[fragment.attribs.from]) {
        dependencyList.gateways[fragment.attribs.from] = {
          gateway: null,
          ready: false
        };
      }

      if (!dependencyList.fragments[fragment.attribs.name]) {
        this.fragments[fragment.attribs.name] = new FragmentStorefront(fragment.attribs.name, fragment.attribs.from);
        dependencyList.fragments[fragment.attribs.name] = {
          gateway: fragment.attribs.from,
          instance: this.fragments[fragment.attribs.name]
        };
      }

      if (this.fragments[fragment.attribs.name].primary === false) {
        if (typeof fragment.attribs.primary !== 'undefined') {
          if (primaryName != null && primaryName !== fragment.attribs.name) throw new PuzzleError(ERROR_CODES.MULTIPLE_PRIMARY_FRAGMENTS);
          primaryName = fragment.attribs.name;
          this.fragments[fragment.attribs.name].primary = true;
          this.fragments[fragment.attribs.name].shouldWait = true;
        }
      }

      if (this.fragments[fragment.attribs.name].shouldWait === false) {
        this.fragments[fragment.attribs.name].shouldWait = typeof fragment.attribs.shouldwait !== 'undefined' || (fragment.parent && fragment.parent.name === 'head') || false;
      }


      return dependencyList;
    }, {
      gateways: {},
      fragments: {}
    });
  }

  //todo fragmentConfigleri versiyon bilgileriyle inmis olmali ki assetleri versionlara gore compile edebilelim. ayni not gatewayde de var.
  /**
   * Compiles template and returns a function that can handle the request.
   * @param {ICookieMap} testCookies
   * @param {boolean} isDebug
   * @returns {Promise<IFragmentEndpointHandler>}
   */
  async compile(testCookies: ICookieMap, isDebug: boolean = false): Promise<IFragmentEndpointHandler> {
    if (Object.keys(this.fragments).length === 0) {
      const singleFlushHandlerWithoutFragments = TemplateCompiler.compile(Template.clearHtmlContent(this.dom.html()));
      return this.buildHandler(singleFlushHandlerWithoutFragments, [], [], [], isDebug);
    }

    /* Fragment Types
        chunkedFragmentsWithShouldWait -> Contents will be in first flush, waits for fragment response
        chunkedFragmentsWithoutWait -> Fragments that doesn't need to waited. Flushes after first request.
        staticFragments -> Contents are prepared on compile time. Req independent
     */
    const chunkedFragmentsWithShouldWait = Object.values(this.fragments).filter(fragment => fragment.config && fragment.shouldWait);
    const chunkedFragmentsWithoutWait = Object.values(this.fragments).filter(fragment => fragment.config && !fragment.shouldWait && !fragment.config.render.static);
    const staticFragments = Object.values(this.fragments).filter(fragment => fragment.config && fragment.config.render.static);

    const replaceScripts = await this.prepareJsAssetLocations();
    const waitedFragmentReplacements: IReplaceSet[] = this.replaceWaitedFragmentContainers(chunkedFragmentsWithShouldWait, replaceScripts, isDebug);

    const chunkReplacements: IReplaceSet[] = this.replaceChunkedFragmentContainers(chunkedFragmentsWithoutWait);

    this.replaceUnfetchedFragments(Object.values(this.fragments).filter(fragment => !fragment.config));

    await this.addDependencies();
    await this.replaceStaticFragments(staticFragments, replaceScripts.filter(replaceSet => replaceSet.fragment.config && replaceSet.fragment.config.render.static));
    await this.appendPlaceholders(chunkReplacements);
    await this.buildStyleSheets();
    this.replaceEmptyTags();

    return this.buildHandler(TemplateCompiler.compile(Template.clearHtmlContent(this.dom.html())), chunkReplacements, waitedFragmentReplacements, replaceScripts, isDebug);
  }

  /**
   * Wraps js asset based on its configuration
   * @param {IWrappingJsAsset} asset
   * @returns {string}
   */
  static wrapJsAsset(asset: IWrappingJsAsset) {
    if (asset.injectType === RESOURCE_INJECT_TYPE.EXTERNAL && asset.link) {
      return `<script puzzle-dependency="${asset.name}" src="${asset.link}" type="text/javascript"${asset.executeType}> </script>`;
    } else if (asset.injectType === RESOURCE_INJECT_TYPE.INLINE && asset.content) {
      return `<script puzzle-dependency="${asset.name}" type="text/javascript">${asset.content}</script>`;
    } else {
      //todo handle error
      return `<!-- Failed to inject asset: ${asset.name} -->`;
    }
  }


  /**
   * Bind user class to page
   */
  private bindPageClass(): void {
    const scriptMatch = TemplateCompiler.PAGE_CLASS_CONTENT_REGEX.exec(this.rawHtml);
    if (scriptMatch) {
      const pageClass = eval(scriptMatch[1]);
      pageClass.__proto__ = new TemplateClass();
      this.pageClass = pageClass;
    }
  }

  /**
   * Appends placeholders to reserved locations
   * @param {IChunkedReplacementSet[]} chunkedReplacements
   * @returns {Promise<void>}
   */
  private async appendPlaceholders(chunkedReplacements: IChunkedReplacementSet[]) {
    for (let replacement of chunkedReplacements) {
      const placeholders = replacement.replaceItems.filter(item => item.type === REPLACE_ITEM_TYPE.PLACEHOLDER);
      for (let placeholderReplacement of placeholders) {
        const placeholderContent = await replacement.fragment.getPlaceholder();
        this.dom(`[puzzle-placeholder="${placeholderReplacement.key}"]`).append(placeholderContent);
      }
    }
  }

  /**
   * Replaces static fragments with their content on vDOM
   * @param {FragmentStorefront[]} fragments
   * @param {IReplaceAsset[]} replaceAssets
   * @returns {Promise<void>}
   */
  private async replaceStaticFragments(fragments: FragmentStorefront[], replaceAssets: IReplaceAsset[]): Promise<void> {
    for (let fragment of fragments) {
      const fragmentContent: IFragmentContentResponse = await fragment.getContent();
      this.dom(`fragment[name="${fragment.name}"][from="${fragment.from}"]`).each((i, element) => {
        const partial = this.dom(element).attr('partial') || 'main';
        const assets = replaceAssets.find(set => set.fragment.name === fragment.name);
        let fragmentScripts = assets ? assets.replaceItems.reduce((script, replaceItem) => {
          script += Template.wrapJsAsset(replaceItem);

          return script;
        }, '') : '';

        this.dom(element).replaceWith(`<div id="${fragment.name}" puzzle-fragment="${fragment.name}" puzzle-gateway="${fragment.from}" fragment-partial="${element.attribs.partial || 'main'}">${fragmentContent.html[partial] || CONTENT_NOT_FOUND_ERROR}</div>${fragmentScripts}`);

      });
    }
  }

  private replaceEmptyTags(): any {
    this.dom('*').each((i, element) => {
      if(NON_SELF_CLOSING_TAGS.indexOf(this.dom(element)[0].name) !== -1 && this.dom(element).text().length === 0){
        this.dom(element).text(' ');
      }
    });
  }

  /**
   * Replaces waited fragments with their content on first flush string.
   * @param {IReplaceSet[]} waitedFragments
   * @param {string} template
   * @param req
   * @param isDebug
   * @returns {Promise<IWaitedResponseFirstFlush>}
   */
  @benchmark(isDebug(), logger.info)
  private async replaceWaitedFragments(waitedFragments: IReplaceSet[], template: string, req: any, isDebug: boolean): Promise<IWaitedResponseFirstFlush> {
    let statusCode = HTTP_STATUS_CODE.OK;
    let headers = {};

    for (let waitedFragmentReplacement of waitedFragments) {
      const fragmentContent = await waitedFragmentReplacement.fragment.getContent(waitedFragmentReplacement.fragmentAttributes, req);
      if (waitedFragmentReplacement.fragment.primary) {
        statusCode = fragmentContent.status;
        headers = fragmentContent.headers;
      }


      const modelReplacement = waitedFragmentReplacement.replaceItems.find(item => item.type === REPLACE_ITEM_TYPE.MODEL_SCRIPT);
      if (modelReplacement) {
        template = template.replace(`${modelReplacement.key}`, Template.fragmentModelScript(waitedFragmentReplacement.fragment, fragmentContent.model, isDebug));
      }

      waitedFragmentReplacement.replaceItems
        .forEach(replaceItem => {
          if (replaceItem.type === REPLACE_ITEM_TYPE.CONTENT) {
            let fragmentInject = fragmentContent.html[replaceItem.partial] || CONTENT_NOT_FOUND_ERROR;
            template = template.replace(replaceItem.key, () => fragmentInject);
          }
        });
    }

    return {template, statusCode, headers};
  }

  static fragmentModelScript(fragment: { name: string }, fragmentPageModel: FragmentModel, isDebug: boolean = false) {
    return fragmentPageModel && Object.keys(fragmentPageModel).length ? `<script>${Object.keys(fragmentPageModel).reduce((modelVariable, key) => {
      modelVariable += `window['${key}']=window['${key}']||${JSON.stringify(fragmentPageModel[key])};${isDebug ? `PuzzleJs.variables.add('${fragment.name}','${key}');` : ""}`;
      return modelVariable;
    }, '')}</script>` : '';
  }

  /**
   * Creates a request handler from the compilation output. Express requests drops to return of this method
   * @param {Function} firstFlushHandler
   * @param {IReplaceSet[]} chunkedFragmentReplacements
   * @param {IReplaceSet[]} waitedFragments
   * @param {IReplaceAsset[]} jsReplacements
   * @param isDebug
   * @returns {(req: any, res: any) => void}
   */
  private buildHandler(firstFlushHandler: Function, chunkedFragmentReplacements: IReplaceSet[], waitedFragments: IReplaceSet[] = [], jsReplacements: IReplaceAsset[] = [], isDebug: boolean) {
    //todo primary fragment test et
    if (chunkedFragmentReplacements.length === 0) {
      return (req: any, res: any) => {
        this.pageClass._onRequest(req);
        let fragmentedHtml = firstFlushHandler.call(this.pageClass, req);
        (async () => {
          const waitedReplacement = await this.replaceWaitedFragments(waitedFragments, fragmentedHtml, req, isDebug);
          for (let prop in waitedReplacement.headers) {
            res.set(prop, waitedReplacement.headers[prop]);
          }
          res.status(waitedReplacement.statusCode);
          if (waitedReplacement.statusCode === HTTP_STATUS_CODE.MOVED_PERMANENTLY) {
            res.end();
            this.pageClass._onResponseEnd();
          } else {
            if (isDebug) {
              res.send(waitedReplacement.template.replace('</body></html>', () => '<script>PuzzleJs.analytics.end();PuzzleJs.variables.end();</script></body></html>').replace('<head>', () => `<head><script src="${PUZZLE_DEBUGGER_LINK}" type="text/javascript"></script><script>PuzzleJs.fragments.set(${JSON.stringify(this.fragments)})</script>`));
            } else {
              res.send(waitedReplacement.template);
            }
            this.pageClass._onResponseEnd();
          }

        })();
      };
    } else {
      let bodyAndAssets = ``;
      jsReplacements.forEach(replacement => {
        replacement.replaceItems.filter(item => item.location === RESOURCE_LOCATION.BODY_END).forEach(replaceItem => {
          bodyAndAssets += Template.wrapJsAsset(replaceItem);
        });
      });
      return (req: any, res: any) => {
        this.pageClass._onRequest(req);
        let fragmentedHtml = firstFlushHandler.call(this.pageClass, req).replace('</body>', '').replace('</html>', '');
        res.set('transfer-encoding', 'chunked');
        res.set('content-type', 'text/html; charset=UTF-8');
        (async () => {
          const waitedPromises: Promise<any>[] = [];

          //Fire requests in parallel
          const waitedReplacementPromise = this.replaceWaitedFragments(waitedFragments, fragmentedHtml, req, isDebug);
          for (let chunkedReplacement of chunkedFragmentReplacements) {
            waitedPromises.push(chunkedReplacement.fragment.getContent(chunkedReplacement.fragmentAttributes, req));
          }

          //Wait for first flush
          const waitedReplacement = await waitedReplacementPromise;
          for (let prop in waitedReplacement.headers) {
            res.set(prop, waitedReplacement.headers[prop]);
          }
          res.status(waitedReplacement.statusCode);
          if (waitedReplacement.statusCode === HTTP_STATUS_CODE.MOVED_PERMANENTLY) {
            res.end();
            this.pageClass._onResponseEnd();
          } else {
            if (isDebug) {
              res.write(waitedReplacement.template.replace('<head>', () => `<head><script src="${PUZZLE_DEBUGGER_LINK}" type="text/javascript"></script><script>PuzzleJs.fragments.set(${JSON.stringify(this.fragments)})</script>`));
            } else {
              res.write(waitedReplacement.template);
            }

            //Bind flush method to resolved or being resolved promises of chunked replacements
            Object.values(chunkedFragmentReplacements).forEach((chunkedReplacement, x) => {
              waitedPromises[x].then(this.flush(chunkedReplacement, jsReplacements, res, isDebug));
            });

            //Close stream after all chunked fragments done
            await Promise.all(waitedPromises);
            if (isDebug) {
              res.end(`${bodyAndAssets}<script>PuzzleJs.analytics.end();PuzzleJs.variables.end();</script></body></html>`);
            } else {
              res.end(`${bodyAndAssets}</body></html>`);
            }
            this.pageClass._onResponseEnd();
          }
        })();
      };
    }
  }


  /**
   * Flushes incoming fragment response
   * @param {IReplaceSet} chunkedReplacement
   * @param {IReplaceAsset[]} jsReplacements
   * @param res
   * @param isDebug
   * @returns {(fragmentContent: IFragmentContentResponse) => void}
   */
  private flush(chunkedReplacement: IReplaceSet, jsReplacements: IReplaceAsset[], res: any, isDebug: boolean) {
    return (fragmentContent: IFragmentContentResponse) => {

      const fragmentJsReplacements = jsReplacements.find(jsReplacement => jsReplacement.fragment.name === chunkedReplacement.fragment.name);
      const selfReplacing = chunkedReplacement.fragment.config && chunkedReplacement.fragment.config.render.selfReplace;

      let output = isDebug ? `<script>PuzzleJs.analytics.fragment('${chunkedReplacement.fragment.name}')</script>` : '';

      output += Template.fragmentModelScript(chunkedReplacement.fragment, fragmentContent.model, isDebug);

      fragmentJsReplacements && fragmentJsReplacements.replaceItems.filter(item => item.location === RESOURCE_LOCATION.CONTENT_START).forEach(replaceItem => {
        output += Template.wrapJsAsset(replaceItem);
      });

      chunkedReplacement.replaceItems
        .forEach(replaceItem => {
          if (replaceItem.type === REPLACE_ITEM_TYPE.CHUNKED_CONTENT) {
            output += `<div style="display: none;" puzzle-fragment="${chunkedReplacement.fragment.name}" puzzle-chunk-key="${replaceItem.key}">${fragmentContent.html[replaceItem.partial] || CONTENT_NOT_FOUND_ERROR}</div>`;
            if (!(replaceItem.key === 'main' && selfReplacing)) {
              output += `<script>$p('[puzzle-chunk="${replaceItem.key}"]','[puzzle-chunk-key="${replaceItem.key}"]');</script>`;
            }
          }
        });

      fragmentJsReplacements && fragmentJsReplacements.replaceItems.filter(item => item.location === RESOURCE_LOCATION.CONTENT_END).forEach(replaceItem => {
        output += Template.wrapJsAsset(replaceItem);
      });

      if (isDebug) {
        output += `<script>PuzzleJs.analytics.fragment('${chunkedReplacement.fragment.name}')</script>`;
      }
      this.pageClass._onChunk(output);
      res.write(output);
    };
  }

  /**
   * Clears html content from empty spaces
   * @param {string} str
   * @returns {string}
   */
  private static clearHtmlContent(str: string) {
    return str.replace(/>\s+</g, "><").trim();
  }

  /**
   * Replaces unfetched fragments with empty div error
   * @param {FragmentStorefront[]} fragments
   */
  @benchmark(isDebug(), logger.info)
  private replaceUnfetchedFragments(fragments: FragmentStorefront[]) {
    fragments.forEach(fragment => {
      this.dom(`fragment[from="${fragment.from}"][name="${fragment.name}"]`).replaceWith(`<div puzzle-fragment="${fragment.name}" puzzle-gateway="${fragment.from}">${CONTENT_NOT_FOUND_ERROR}</div>`);
    });
  }

  /**
   * Adds required dependencies
   */
  private async addDependencies() {
    let injectedDependencies: string[] = [];

    await Promise.all(Object.values(this.fragments).map(async fragment => {
      if (fragment.config) {
        await Promise.all(Object.values(fragment.config.dependencies).map(async dependency => {
          if (injectedDependencies.indexOf(dependency.name) == -1) {
            injectedDependencies.push(dependency.name);
            this.dom('head').append(await ResourceFactory.instance.getDependencyContent(dependency.name, dependency.injectType));
          }
        }));
      }
    }));
  }

  /**
   * Creates chunked fragment containers
   * @param {FragmentStorefront[]} chunkedFragments
   * @returns {IReplaceSet[]}
   */
  @benchmark(isDebug(), logger.info)
  private replaceChunkedFragmentContainers(chunkedFragments: FragmentStorefront[]) {
    const chunkReplacements: IReplaceSet[] = [];

    if (chunkedFragments.length > 0) {
      this.dom('head').append(CONTENT_REPLACE_SCRIPT);
    }

    chunkedFragments.forEach(fragment => {
      let replaceItems: IReplaceItem[] = [];
      let fragmentAttributes = {};
      this.dom(`fragment[from="${fragment.from}"][name="${fragment.name}"]`)
        .each((i, element) => {
          const partial = element.attribs.partial || 'main';
          const contentKey = fragment.name + '_' + partial;
          let replaceItem = {
            type: REPLACE_ITEM_TYPE.CHUNKED_CONTENT,
            partial: partial,
            key: contentKey,
          };
          if (partial === 'main') {
            fragmentAttributes = element.attribs;
          }
          replaceItems.push(replaceItem);
          if (fragment.config && fragment.config.render.placeholder && replaceItem.partial === 'main') {
            let placeholderContentKey = contentKey + '_placeholder';
            replaceItems.push({
              type: REPLACE_ITEM_TYPE.PLACEHOLDER,
              partial: partial,
              key: placeholderContentKey
            });
            this.dom(element).replaceWith(`<div id="${fragment.name}" puzzle-fragment="${element.attribs.name}" puzzle-gateway="${element.attribs.from}" ${element.attribs.partial ? 'fragment-partial="' + element.attribs.partial + '"' : ''} puzzle-chunk="${contentKey}" puzzle-placeholder="${placeholderContentKey}"></div>`);
          } else {
            this.dom(element).replaceWith(`<div id="${fragment.name}" puzzle-fragment="${element.attribs.name}" puzzle-gateway="${element.attribs.from}" ${element.attribs.partial ? 'fragment-partial="' + element.attribs.partial + '"' : ''} puzzle-chunk="${contentKey}"> </div>`);
          }
        });

      chunkReplacements.push({
        fragment,
        replaceItems,
        fragmentAttributes
      });
    });

    return chunkReplacements;
  }

  /**
   * Creates containers for fragments should be waited
   * @param {FragmentStorefront[]} fragmentsShouldBeWaited
   * @param {IReplaceAsset[]} replaceJsAssets
   * @returns {IReplaceSet[]}
   */
  @benchmark(isDebug(), logger.info)
  private replaceWaitedFragmentContainers(fragmentsShouldBeWaited: FragmentStorefront[], replaceJsAssets: IReplaceAsset[], isDebug: boolean) {
    const waitedFragmentReplacements: IReplaceSet[] = [];

    fragmentsShouldBeWaited.forEach(fragment => {
      let replaceItems: IReplaceItem[] = [];
      let fragmentAttributes = {};

      const jsReplacements = replaceJsAssets.find(jsReplacement => jsReplacement.fragment.name === fragment.name);
      let contentStart = isDebug ? `<script>PuzzleJs.analytics.fragment('${fragment.name}')</script>` : '';
      let contentEnd = ``;

      const replaceModelKey = `{fragment|${fragment.name}_pageModel}`;

      replaceItems.push({
        type: REPLACE_ITEM_TYPE.MODEL_SCRIPT,
        key: replaceModelKey,
        partial: DEFAULT_MAIN_PARTIAL,
      });

      jsReplacements && jsReplacements.replaceItems.filter(item => item.location === RESOURCE_LOCATION.CONTENT_START).forEach(replaceItem => {
        contentStart += Template.wrapJsAsset(replaceItem);
      });

      jsReplacements && jsReplacements.replaceItems.filter(item => item.location === RESOURCE_LOCATION.CONTENT_END).forEach(replaceItem => {
        contentEnd += Template.wrapJsAsset(replaceItem);
      });

      if (isDebug) {
        contentEnd += `<script>PuzzleJs.analytics.fragment('${fragment.name}')</script>`;
      }

      this.dom(contentStart).insertBefore(this.dom(`fragment[from="${fragment.from}"][name="${fragment.name}"]`).first());
      this.dom(contentEnd).insertAfter(this.dom(`fragment[from="${fragment.from}"][name="${fragment.name}"]`).last());


      this.dom(`fragment[from="${fragment.from}"][name="${fragment.name}"]`)
        .each((i, element) => {
          let replaceKey = `{fragment|${element.attribs.name}_${element.attribs.from}_${element.attribs.partial || 'main'}}`;
          const partial = element.attribs.partial || 'main';
          replaceItems.push({
            type: REPLACE_ITEM_TYPE.CONTENT,
            key: replaceKey,
            partial: partial,
          });
          if (partial === 'main') {
            fragmentAttributes = element.attribs;
          }

          if (element.parentNode.name !== 'head') {
            this.dom(element).replaceWith(`${i === 0 ? replaceModelKey : ''}<div id="${fragment.name}" puzzle-fragment="${element.attribs.name}" puzzle-gateway="${element.attribs.from}" ${element.attribs.partial ? 'fragment-partial="' + element.attribs.partial + '"' : ''}>${replaceKey}</div>`);
          } else {
            this.dom(element).replaceWith((i === 0 ? replaceModelKey : '') + replaceKey);
          }
        });


      waitedFragmentReplacements.push({
        fragment,
        replaceItems,
        fragmentAttributes
      });
    });

    return waitedFragmentReplacements;
  }

  /**
   * Prepares JS asset replacements and replaces HEAD, BODY_START
   * @returns {Promise<IReplaceAsset[]>}
   */
  private async prepareJsAssetLocations(): Promise<IReplaceAsset[]> {
    const replaceScripts: IReplaceAsset[] = [];

    await Promise.all(Object.keys(this.fragments).map(async (fragmentName) => {
      const fragment = this.fragments[fragmentName];

      if (fragment.config) {
        const replaceItems: IReplaceAssetSet[] = [];
        await Promise.all(fragment.config.assets.filter(asset => asset.type === RESOURCE_TYPE.JS).map(async asset => {
          let assetContent = null;
          if (asset.injectType === RESOURCE_INJECT_TYPE.INLINE) {
            assetContent = await fragment.getAsset(asset.name);
          }
          switch (asset.location) {
            case RESOURCE_LOCATION.HEAD:
              this.dom('head').append(Template.wrapJsAsset({
                name: asset.name,
                injectType: asset.injectType,
                link: fragment.getAssetPath(asset.name),
                content: assetContent,
                executeType: asset.executeType || RESOURCE_JS_EXECUTE_TYPE.SYNC
              }));
              break;
            case RESOURCE_LOCATION.BODY_START:
              this.dom('body').prepend(Template.wrapJsAsset({
                name: asset.name,
                injectType: asset.injectType,
                link: fragment.getAssetPath(asset.name),
                content: assetContent,
                executeType: asset.executeType || RESOURCE_JS_EXECUTE_TYPE.SYNC
              }));
              break;
            case RESOURCE_LOCATION.CONTENT_START:
            case RESOURCE_LOCATION.CONTENT_END:
            case RESOURCE_LOCATION.BODY_END:
              replaceItems.push({
                content: assetContent,
                name: asset.name,
                link: fragment.getAssetPath(asset.name),
                injectType: asset.injectType,
                location: asset.location,
                executeType: asset.executeType || RESOURCE_JS_EXECUTE_TYPE.SYNC
              });
              break;
          }

        }));
        replaceScripts.push({
          fragment,
          replaceItems
        });
      }
    }));

    return replaceScripts;
  }


  /**
   * Merges, minifies stylesheets and inject them into a page
   * @returns {Promise<void>}
   */
  private async buildStyleSheets() {
    const _CleanCss = new CleanCSS({
      level: {
        1: {
          all: true
        }
      }
    } as any);

    let styleSheets: string[] = [];


    for (let fragment of Object.values(this.fragments)) {
      if (!fragment.config) return;

      const cssAssets = fragment.config.assets.filter(asset => asset.type === RESOURCE_TYPE.CSS);

      for (let asset of cssAssets) {
        const assetContent = await fragment.getAsset(asset.name);

        if (assetContent) {
          styleSheets.push(assetContent);
        }
      }
    }


    let output = _CleanCss.minify(styleSheets.join(''));
    if (output.styles.length > 0) {
      const styleHash = md5(output.styles);
      const path = `/static/${this.name}.min.css`;
      pubsub.emit(EVENTS.ADD_ROUTE, {
        path: path,
        method: HTTP_METHODS.GET,
        handler(req: any, res: any) {
          res.set('content-type', 'text/css');
          res.set('cache-control', 'public, max-age=31557600');
          res.send(output.styles);
        }
      });

      this.dom('head').append(`<link puzzle-dependency="dynamic" rel="stylesheet" href="${path}?v=${styleHash}" />`);
    }
  }
}

