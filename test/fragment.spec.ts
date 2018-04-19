import "mocha";
import {expect} from "chai";
import {FragmentBFF, FragmentStorefront} from "../src/lib/fragment";
import {IFragmentBFF} from "../src/types/fragment";
import nock from "nock";
import {FRAGMENT_RENDER_MODES} from "../src/lib/enums";
import {deepEqual} from "assert";


describe('Fragment', () => {
    describe('BFF', () => {
        const commonFragmentBffConfiguration: any = {
            name: 'test',
            version: 'test',
            render: {
                url: "/"
            },
            versions: {
                "test": {
                    assets: [],
                    dependencies: [],
                    handler: {}
                }
            }
        };

        it('should create a new FragmentBFF', () => {
            const fragmentConfig = JSON.parse(JSON.stringify(commonFragmentBffConfiguration));
            fragmentConfig.versions.test.handler.content = () => {
            };
            const fragment = new FragmentBFF(fragmentConfig);
            expect(fragment).to.be.instanceOf(FragmentBFF);
        });

        it('should render fragment as json format', async () => {
            const fragmentConfig = JSON.parse(JSON.stringify(commonFragmentBffConfiguration));
            fragmentConfig.versions.test.handler.content = (req: any, data: any) => {
                return {
                    main: `${data} was here`
                }
            };
            fragmentConfig.versions.test.handler.data = () => 'acg';
            const fragment = new FragmentBFF(fragmentConfig);
            const response = await fragment.render({});
            expect(response).to.deep.eq({
                main: `acg was here`
            });
        });

        it('should throw at render error when not static and no data', done => {
            const fragmentConfig = JSON.parse(JSON.stringify(commonFragmentBffConfiguration));
            fragmentConfig.versions.test.handler.content = (req: any, data: any) => `${data} was here`;
            const fragment = new FragmentBFF(fragmentConfig);
            fragment.render({}).then(data => done(data)).catch(e => {
                expect(e.message).to.include('Failed to find data handler');
                done();
            });
        });

        it('should render fragment which is static without calling data', done => {
            const fragmentConfig = JSON.parse(JSON.stringify(commonFragmentBffConfiguration));
            fragmentConfig.render.static = true;
            fragmentConfig.versions.test.handler.content = (req: any, data: any) => `${data} was here`;
            fragmentConfig.versions.test.handler.data = (req: any) => {
                throw new Error("It shouldn't call data for static fragments");
            };
            const fragment = new FragmentBFF(fragmentConfig);
            fragment.render({}).then(data => done()).catch(done);
        });

        it('should throw at render when failing to find version', done => {
            const fragmentConfig = JSON.parse(JSON.stringify(commonFragmentBffConfiguration));
            fragmentConfig.versions.test.handler.content = (req: any, data: any) => `${data} was here`;
            fragmentConfig.versions.test.handler.data = () => 'acg';
            const fragment = new FragmentBFF(fragmentConfig);
            fragment.render({}, 'no_version').then(data => done(data)).catch(e => {
                expect(e.message).to.include('Failed to find fragment version');
                done();
            });
        });
    });

    describe('Storefront', () => {
        const commonFragmentConfig = {
            version: '',
            testCookie: 'test',
            assets: [],
            dependencies: [],
            render: {
                url: '/',
                placeholder: true
            }
        };

        it('should create new storefront fragment instance', () => {
            const fragment = new FragmentStorefront('product');

            expect(fragment).to.be.instanceOf(FragmentStorefront);
        });

        it('should update fragment configuration', () => {
            const fragment = new FragmentStorefront('product');
            fragment.update(commonFragmentConfig, 'http://local.gatewaysimulator.com');

            expect(fragment.config).to.deep.eq(commonFragmentConfig);
        });

        it('should fetch placeholder', async () => {
            let placeholderContent = '<div>placeholder</div>';
            let scope = nock('http://local.gatewaysimulator.com')
                .get('/product/placeholder')
                .reply(200, placeholderContent);
            const fragment = new FragmentStorefront('product');
            fragment.update(commonFragmentConfig, 'http://local.gatewaysimulator.com');

            const placeholder = await fragment.getPlaceholder();
            expect(placeholder).to.eq(placeholderContent);
        });

        it('should return empty placeholder on any exception', async () => {
            const fragment = new FragmentStorefront('product');
            fragment.update(commonFragmentConfig, 'http://local.gatewaysimulator.com');

            const placeholder = await fragment.getPlaceholder();
            expect(placeholder).to.eq('');
        });

        it('should return fragment content', async () => {
            let fragmentContent = {
                main: '<div>fragment</div>'
            };
            let scope = nock('http://local.gatewaysimulator.com')
                .get('/product/')
                .query({__renderMode: FRAGMENT_RENDER_MODES.STREAM})
                .reply(200, fragmentContent);
            const fragment = new FragmentStorefront('product');
            fragment.update(commonFragmentConfig, 'http://local.gatewaysimulator.com');

            const content = await fragment.getContent();
            expect(JSON.parse(content)).to.deep.eq(fragmentContent);
        });

        
    });
});