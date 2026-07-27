const eslint = require('@eslint/js');

module.exports = [
    {
        ignores: [
            'dist/**',
            'docs/pptx-polish/**',
            'js/vendor/**',
            'ui-mockup.html'
        ]
    },
    eslint.configs.recommended,
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script'
        },
        rules: {
            // Legacy browser features currently share explicit globals across
            // classic scripts. The feature-registry migration will tighten this.
            'no-undef': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-useless-assignment': 'off',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
        }
    },
    {
        files: ['tests/**/*.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs'
        },
        rules: {
            'no-undef': 'off',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
        }
    }
];
