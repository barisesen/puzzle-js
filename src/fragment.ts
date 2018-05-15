import fetch from "node-fetch";
import {IFragmentContentResponse} from "./page";
import {FRAGMENT_RENDER_MODES} from "./enums";
import * as querystring from "querystring";
import {DEFAULT_CONTENT_TIMEOUT} from "./config";
import {IFileResourceAsset, IFileResourceDependency} from "./resourceFactory";
import {IExposeFragment} from "./gateway";
import {logger} from "./logger";
import url from "url";

export interface IFragmentCookieMap {
    name: string;
    live: string;
}

export interface IFragment {
    name: string;
}

export interface IFragmentBFFRender {
    static?: boolean;
    url: string;
    routeCache?: number;
    selfReplace?: boolean;
    middlewares?: [Function[]];
    cacheControl?: string;
    placeholder?: boolean;
    timeout?: number;
}

export interface IFragmentHandler {
    content: (req: object, data?: any) => {
        main: string;
        [name: string]: string;
    };
    placeholder: () => string;
    data: (req: object) => any;
}

export interface IFragmentBFFVersion {
    assets: IFileResourceAsset[];
    dependencies: IFileResourceDependency[];
    handler: IFragmentHandler;
}

export interface IFragmentBFF extends IFragment {
    versions: {
        [version: string]: IFragmentBFFVersion
    };
    version: string;
    testCookie: string;
    render: IFragmentBFFRender;
}

export class Fragment {
    name: string;

    constructor(config: IFragment) {
        this.name = config.name;
    }
}

export class FragmentBFF extends Fragment {
    public config: IFragmentBFF;

    constructor(config: IFragmentBFF) {
        super({name: config.name});
        this.config = config;
    }

    /**
     * Renders fragment: data -> content
     * @param {object} req
     * @param {string} version
     * @returns {Promise<{main: string; [p: string]: string}>}
     */
    async render(req: object, version?: string) {
        const fragmentVersion = this.config.versions[version || this.config.version];
        if (fragmentVersion) {
            if (this.config.render.static) {
                return fragmentVersion.handler.content(req);
            } else {
                if (fragmentVersion.handler.data) {
                    const data = await fragmentVersion.handler.data(req);
                    return fragmentVersion.handler.content(req, data);
                } else {
                    throw new Error(`Failed to find data handler for fragment. Fragment: ${this.config.name}, Version: ${version || this.config.version}`);
                }
            }
        } else {
            throw new Error(`Failed to find fragment version. Fragment: ${this.config.name}, Version: ${version || this.config.version}`);
        }
    }

    placeholder(req: object, version?: string) {
        const fragmentVersion = version && this.config.versions[version] ? this.config.versions[version] : this.config.versions[this.config.version];
        if (fragmentVersion) {
            return fragmentVersion.handler.placeholder();
        } else {
            throw new Error(`Failed to find fragment version. Fragment: ${this.config.name}, Version: ${version || this.config.version}`);
        }
    }
}

export class FragmentStorefront extends Fragment {
    config: IExposeFragment | undefined;
    primary = false;
    shouldWait = false;
    from: string;
    public fragmentUrl: string | undefined;

    constructor(name: string, from: string) {
        super({name});

        this.from = from;
    }

    /**
     * Updates fragment configuration
     * @param {IExposeFragment} config
     * @param {string} gatewayUrl
     */
    update(config: IExposeFragment, gatewayUrl: string) {
        this.fragmentUrl = url.resolve(gatewayUrl, this.name);
        this.config = config;
    }

    /**
     * Returns fragment placeholder as promise, fetches from gateway
     * @returns {Promise<string>}
     */
    async getPlaceholder(): Promise<string> {
        if (!this.config) {
            logger.error(new Error(`No config provided for fragment: ${this.name}`));
            return '';
        }

        if (!this.config.render.placeholder) {
            logger.error(new Error('Placeholder is not enabled for fragment'));
            return '';
        }

        return fetch(`${this.fragmentUrl}/placeholder`)
            .then(res => res.text())
            .then(html => {
                return html;
            })
            .catch(err => {
                logger.error(`Failed to fetch placeholder for fragment: ${this.fragmentUrl}/placeholder`, err);
                return '';
            });
    }

    /**
     * Fetches fragment content as promise, fetches from gateway
     * Returns {
     *  html: {
     *    Partials
     *  },
     *  status: gateway status response code
     * }
     * @param attribs
     * @returns {Promise<IFragmentContentResponse>}
     */
    async getContent(attribs: any = {}): Promise<IFragmentContentResponse> {
        if (!this.config) {
            logger.error(new Error(`No config provided for fragment: ${this.name}`));
            return {
                status: 500,
                html: {}
            };
        }

        const query = {
            ...attribs,
            __renderMode: FRAGMENT_RENDER_MODES.STREAM
        };

        delete query.from;
        delete query.name;
        delete query.partial;
        delete query.primary;
        delete query.shouldwait;

        //todo pass cookies too
        return fetch(`${this.fragmentUrl}${this.config.render.url}?${querystring.stringify(query)}`, {
            timeout: this.config.render.timeout || DEFAULT_CONTENT_TIMEOUT
        })
            .then(async res => {
                return {
                    status: res.status,
                    html: await res.json()
                };
            })
            .catch(err => {
                logger.error(`Failed to get contents for fragment: ${this.name}`, err);
                return {
                    status: 500,
                    html: {}
                };
            });
    }

    async getAsset(name: string) {
        if (!this.config) {
            logger.error(new Error(`No config provided for fragment: ${this.name}`));
            return null;
        }

        const asset = this.config.assets.find(asset => asset.name === name);
        if (!asset) {
            logger.error(new Error(`Asset not declared in fragments asset list: ${name}`));
            return null;
        }

        return fetch(`${this.fragmentUrl}/static/${asset.fileName}`).then(async res => {
            return await res.text();
        }).catch(e => {
            logger.error(new Error(`Failed to fetch asset from gateway: ${this.fragmentUrl}/static/${asset.fileName}`));
            return null;
        });
    }

    getAssetPath(name: string) {
        if (!this.config) {
            logger.error(new Error(`No config provided for fragment: ${this.name}`));
            return null;
        }

        const asset = this.config.assets.find(asset => asset.name === name);

        if (!asset) {
            logger.error(new Error(`Asset not declared in fragments asset list: ${name}`));
            return null;
        }

        return `${this.fragmentUrl}/static/${asset.fileName}`;
    }
}

