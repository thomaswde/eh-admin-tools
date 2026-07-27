(function attachFeatureRegistry(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.FeatureRegistry = api.FeatureRegistry;
        root.featureRegistry = new api.FeatureRegistry();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildFeatureRegistry() {
    'use strict';

    class FeatureRegistry {
        constructor() {
            this.features = new Map();
            this.activeFeature = null;
        }

        register(name, definition = {}) {
            const featureName = String(name || '').trim();
            if (!featureName) throw new Error('Feature registration requires a name.');
            if (this.features.has(featureName)) {
                throw new Error(`Feature '${featureName}' is already registered.`);
            }
            for (const hook of ['initialize', 'activate', 'deactivate', 'cancel']) {
                if (definition[hook] !== undefined && typeof definition[hook] !== 'function') {
                    throw new TypeError(`Feature '${featureName}' ${hook} hook must be a function.`);
                }
            }
            this.features.set(featureName, {
                definition: { ...definition },
                initialized: false,
                initializing: null
            });
            return definition;
        }

        has(name) {
            return this.features.has(String(name));
        }

        require(name) {
            const featureName = String(name);
            const record = this.features.get(featureName);
            if (!record) throw new Error(`Feature '${featureName}' is not registered.`);
            return record;
        }

        initialize(name) {
            const featureName = String(name);
            const record = this.require(featureName);
            if (record.initialized) return Promise.resolve();
            if (record.initializing) return record.initializing;
            const pending = Promise.resolve()
                .then(() => record.definition.initialize?.())
                .then(() => {
                    record.initialized = true;
                })
                .finally(() => {
                    if (record.initializing === pending) record.initializing = null;
                });
            record.initializing = pending;
            return pending;
        }

        async activate(name, context = {}) {
            const featureName = String(name);
            await this.initialize(featureName);
            if (this.activeFeature && this.activeFeature !== featureName) {
                const previousFeature = this.activeFeature;
                try {
                    await this.deactivate(previousFeature, { ...context, nextFeature: featureName });
                } catch (error) {
                    console.error(`Feature '${previousFeature}' cleanup failed:`, error);
                }
            }
            const record = this.require(featureName);
            await record.definition.activate?.(context);
            this.activeFeature = featureName;
        }

        async deactivate(name = this.activeFeature, context = {}) {
            if (!name) return;
            const featureName = String(name);
            const record = this.require(featureName);
            let cancellationError = null;
            try {
                try {
                    await record.definition.cancel?.(context);
                } catch (error) {
                    cancellationError = error;
                }
                await record.definition.deactivate?.(context);
                if (cancellationError) throw cancellationError;
            } finally {
                if (this.activeFeature === featureName) this.activeFeature = null;
            }
        }

        getState(name) {
            const record = this.require(name);
            return {
                initialized: record.initialized,
                initializing: record.initializing !== null,
                active: this.activeFeature === String(name)
            };
        }
    }

    return { FeatureRegistry };
});
