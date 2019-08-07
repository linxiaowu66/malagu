import * as paths from 'path';
import { readJsonFile } from './json-file';
import { NodePackage, PublishedNodePackage, sortByKey } from './npm-registry';
import { Component, ComponentPackage } from './component-package';
import { ComponentPackageCollector } from './component-package-collector';
import { ApplicationProps } from './application-props';
import { existsSync } from 'fs';
import mergeWith = require('lodash.mergewith');
import yaml = require('js-yaml');
import { FRONTEND_TARGET, BACKEND_TARGET } from '../constants';

// tslint:disable:no-implicit-dependencies

// tslint:disable-next-line:no-any
export type ApplicationLog = (message?: any, ...optionalParams: any[]) => void;
export class ApplicationPackageOptions {
    readonly projectPath: string;
    readonly log?: ApplicationLog;
    readonly error?: ApplicationLog;
}

export type ApplicationModuleResolver = (modulePath: string) => string;

export function customizer(objValue: any, srcValue: any) {
    if (Array.isArray(objValue)) {
      return srcValue;
    }
  }

export class ApplicationPackage {
    readonly projectPath: string;
    readonly log: ApplicationLog;
    readonly error: ApplicationLog;

    constructor(
        protected readonly options: ApplicationPackageOptions
    ) {
        this.projectPath = options.projectPath;
        this.log = options.log || console.log.bind(console);
        this.error = options.error || console.error.bind(console);
    }

    protected _props: ApplicationProps | undefined;
    get props(): ApplicationProps {
        if (this._props) {
            return this._props;
        }
        let props = mergeWith({}, ApplicationProps.DEFAULT, customizer);
        for (const componentPackage of this.componentPackages) {
            const component = componentPackage.malaguComponent;
            if (component) {
                const { config } = component;
                if (config) {
                    props = mergeWith(props, config, customizer);
                }
            }
        }

        const appConfigPath = this.path('app.yml');
        if (existsSync(appConfigPath)) {
            const appConfig = yaml.safeLoad(appConfigPath);
            props = mergeWith(props, appConfig);
        }

        if (props.mode) {
            const appConfigPathForMode = this.path(`app-${props.mode}.yml`);
            if (existsSync(appConfigPathForMode)) {
                const appConfigForMode = yaml.safeLoad(appConfigPathForMode);
                props = mergeWith(props, appConfigForMode);
            }
        }

        return props;
    }

    protected _pkg: NodePackage | undefined;
    get pkg(): NodePackage {
        if (this._pkg) {
            return this._pkg;
        }
        return this._pkg = readJsonFile(this.packagePath);
    }

    protected _frontendModules: Map<string, string> | undefined;
    protected _backendModules: Map<string, string> | undefined;
    protected _componentPackages: ComponentPackage[] | undefined;

    /**
     * Component packages in the topological order.
     */
    get componentPackages(): ReadonlyArray<ComponentPackage> {
        if (!this._componentPackages) {
            const collector = new ComponentPackageCollector(
                raw => this.newComponentPackage(raw),
                this.resolveModule
            );
            this._componentPackages = collector.collect(this.pkg);
            for (const componentPackage of this._componentPackages) {
                const malaguComponent = <Component>componentPackage.malaguComponent;
                if (malaguComponent.config && malaguComponent.config.auto !== false) {
                    this.addModuleIfExists(componentPackage.name, malaguComponent, true);
                }
                this.parseEntry(componentPackage.name, malaguComponent, true);
            }
            if (!(this.pkg.private === true && this.pkg.workspaces)) {
                const malaguComponent = { ...this.pkg.malaguComponent };
                const name = this.pkg.name || paths.basename(this.projectPath);
                this.addModuleIfExists(name, malaguComponent, false);
                this.parseEntry(name, malaguComponent, false);
                this.pkg.malaguComponent = malaguComponent;
                this._componentPackages.push(<ComponentPackage>this.pkg);
            }
        }
        return this._componentPackages;
    }

    protected parseEntry(name: string, component: Component, isModule: boolean) {
        const config = component.config;
        if (config) {
            const prefix = isModule ? name : '.'
            if (config.frontend && config.frontend.entry) {
                config.frontend.entry = paths.join(prefix, config.frontend.entry);
            }
            if (config.backend && config.backend.entry) {
                config.backend.entry = paths.join(prefix, config.backend.entry);
            }
        }

    }


    protected addModuleIfExists(name: string, component: Component, isModule: boolean): void {
        component.frontends = component.frontends || [];
        component.backends = component.backends || [];
        const frontendModulePath = paths.join('lib', 'browser', `${name}-${FRONTEND_TARGET}-module`);
        const backendModulePath = paths.join('lib', 'node', `${name}-${BACKEND_TARGET}-module`);
        try {
            this.resolveModule(frontendModulePath);
            if (component.frontends.indexOf(frontendModulePath) === -1) {
                component.frontends.push(frontendModulePath);
            }
        } catch (error) {
            // noop
        }
        try {
            this.resolveModule(backendModulePath);
            if (component.backends.indexOf(backendModulePath) === -1) {
                component.backends.push(backendModulePath);
            }
        } catch (error) {
            // noop
        }
    }

    getComponentPackage(component: string): ComponentPackage | undefined {
        return this.componentPackages.find(pkg => pkg.name === component);
    }

    async findComponentPackage(component: string): Promise<ComponentPackage | undefined> {
        return this.getComponentPackage(component);
    }

    protected newComponentPackage(raw: PublishedNodePackage): ComponentPackage {
        return new ComponentPackage(raw);
    }

    get frontendModules(): Map<string, string> {
        if (!this._frontendModules) {
            this._frontendModules = this.computeModules('frontends');
        }
        return this._frontendModules;
    }

    get backendModules(): Map<string, string> {
        if (!this._backendModules) {
            this._backendModules = this.computeModules('backends');
        }
        return this._backendModules;
    }

    protected computeModules<P extends keyof Component>(tagret: P): Map<string, string> {
        const result = new Map<string, string>();
        let moduleIndex = 1;
        for (const componentPackage of this.componentPackages) {
            const component = componentPackage.malaguComponent;
            if (component) {
                const modulePaths = <string[]>component[tagret] || [];
                for (const modulePath of modulePaths) {
                    if (typeof modulePath === 'string') {
                        let componentPath: string;
                        if (componentPackage.name === this.pkg.name) {
                            componentPath = paths.join(paths.resolve(this.projectPath), modulePath).split(paths.sep).join('/');
                        } else {
                            componentPath = paths.join(componentPackage.name, modulePath).split(paths.sep).join('/');
                        }
                        result.set(`${tagret}_${moduleIndex}`, componentPath);
                        moduleIndex = moduleIndex + 1;
                    }
                }
            }
        }
        return result;
    }

    relative(path: string): string {
        return paths.relative(this.projectPath, path);
    }

    path(...segments: string[]): string {
        return paths.resolve(this.projectPath, ...segments);
    }

    get packagePath(): string {
        return this.path('package.json');
    }

    lib(...segments: string[]): string {
        return this.path('lib', ...segments);
    }

    setDependency(name: string, version: string | undefined): boolean {
        const dependencies = this.pkg.dependencies || {};
        const currentVersion = dependencies[name];
        if (currentVersion === version) {
            return false;
        }
        if (version) {
            dependencies[name] = version;
        } else {
            delete dependencies[name];
        }
        this.pkg.dependencies = sortByKey(dependencies);
        return true;
    }

    protected _moduleResolver: undefined | ApplicationModuleResolver;
    /**
     * A node module resolver in the context of the application package.
     */
    get resolveModule(): ApplicationModuleResolver {
        if (!this._moduleResolver) {
            const resolutionPaths = [this.packagePath || process.cwd()];
            this._moduleResolver = modulePath => require.resolve(modulePath, { paths: resolutionPaths });
        }
        return this._moduleResolver!;
    }

    resolveModulePath(moduleName: string, ...segments: string[]): string {
        return paths.resolve(this.resolveModule(moduleName + '/package.json'), '..', ...segments);
    }

}