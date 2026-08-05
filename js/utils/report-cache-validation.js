(function attachReportCacheValidation(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReportCacheValidation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildReportCacheValidation() {
    'use strict';

    const objectTag = value => Object.prototype.toString.call(value);

    function requirePlainObject(value, label) {
        if (objectTag(value) !== '[object Object]') {
            throw new TypeError(`${label} must be an object.`);
        }
        return value;
    }

    function requireArray(value, label, options = {}) {
        if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
        const minLength = options.minLength ?? 0;
        const maxLength = options.maxLength ?? 100_000;
        if (value.length < minLength || value.length > maxLength) {
            throw new RangeError(`${label} must contain between ${minLength} and ${maxLength} items.`);
        }
        return value;
    }

    function requireString(value, label, options = {}) {
        if (value === null && options.nullable) return null;
        if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
        const maxLength = options.maxLength ?? 4096;
        if (value.length > maxLength) throw new RangeError(`${label} exceeds the ${maxLength}-character limit.`);
        if (!options.allowEmpty && !value.length) throw new RangeError(`${label} must not be empty.`);
        return value;
    }

    function requireFiniteNumber(value, label, options = {}) {
        if (value === null && options.nullable) return null;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new TypeError(`${label} must be a finite number.`);
        }
        if (options.integer && !Number.isInteger(value)) throw new TypeError(`${label} must be an integer.`);
        const minimum = options.minimum ?? -Number.MAX_VALUE;
        const maximum = options.maximum ?? Number.MAX_VALUE;
        if (value < minimum || value > maximum) {
            throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
        }
        return value;
    }

    function requireBoolean(value, label) {
        if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
        return value;
    }

    function validateJsonTree(value, options = {}) {
        const label = options.label || 'Cached report';
        const maxDepth = options.maxDepth ?? 12;
        const maxNodes = options.maxNodes ?? 250_000;
        const maxArrayLength = options.maxArrayLength ?? 100_000;
        const maxObjectKeys = options.maxObjectKeys ?? 100_000;
        const maxKeyLength = options.maxKeyLength ?? 256;
        const maxStringLength = options.maxStringLength ?? 128 * 1024;
        const stack = [{ value, depth: 0, label }];
        let nodes = 0;

        while (stack.length) {
            const current = stack.pop();
            nodes += 1;
            if (nodes > maxNodes) throw new RangeError(`${label} exceeds the ${maxNodes}-node limit.`);
            if (current.value === null || typeof current.value === 'boolean') continue;
            if (typeof current.value === 'number') {
                if (!Number.isFinite(current.value)) throw new TypeError(`${current.label} must contain finite numbers.`);
                continue;
            }
            if (typeof current.value === 'string') {
                if (current.value.length > maxStringLength) {
                    throw new RangeError(`${current.label} exceeds the ${maxStringLength}-character string limit.`);
                }
                continue;
            }
            if (typeof current.value !== 'object') {
                throw new TypeError(`${current.label} contains a non-JSON value.`);
            }
            if (current.depth >= maxDepth) throw new RangeError(`${current.label} exceeds the depth limit.`);

            if (Array.isArray(current.value)) {
                if (current.value.length > maxArrayLength) {
                    throw new RangeError(`${current.label} exceeds the ${maxArrayLength}-item array limit.`);
                }
                current.value.forEach((item, index) => {
                    stack.push({ value: item, depth: current.depth + 1, label: `${current.label}[${index}]` });
                });
                continue;
            }

            requirePlainObject(current.value, current.label);
            const keys = Object.keys(current.value);
            if (keys.length > maxObjectKeys) {
                throw new RangeError(`${current.label} exceeds the ${maxObjectKeys}-field object limit.`);
            }
            keys.forEach(key => {
                if (key.length > maxKeyLength) throw new RangeError(`${current.label} contains an oversized field name.`);
                if (['__proto__', 'prototype', 'constructor'].includes(key)) {
                    throw new TypeError(`${current.label} contains a forbidden field name.`);
                }
                stack.push({
                    value: current.value[key],
                    depth: current.depth + 1,
                    label: `${current.label}.${key}`
                });
            });
        }
        return value;
    }

    return {
        requirePlainObject,
        requireArray,
        requireString,
        requireFiniteNumber,
        requireBoolean,
        validateJsonTree
    };
}));
