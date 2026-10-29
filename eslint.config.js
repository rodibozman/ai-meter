// GJS has no Node globals; list the few it provides.
const gjsGlobals = {
    console: 'readonly', globalThis: 'readonly', imports: 'readonly', ARGV: 'readonly',
    print: 'readonly', printerr: 'readonly', log: 'readonly', logError: 'readonly',
    TextDecoder: 'readonly', TextEncoder: 'readonly', setTimeout: 'readonly',
    clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
};

export default [
    {ignores: ['dist/**', 'node_modules/**']},
    {
        files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
        languageOptions: {ecmaVersion: 2022, sourceType: 'module', globals: gjsGlobals},
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'eqeqeq': ['error', 'smart'],
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'no-trailing-spaces': 'error',
        },
    },
];
