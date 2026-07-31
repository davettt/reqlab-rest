import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';

const reactHookRules =
  reactHooks.configs['recommended-latest']?.rules ?? reactHooks.configs.recommended.rules;

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'local_data', 'coverage'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHookRules,
    },
  },
  {
    files: ['server/**/*.js', 'tests/**/*.js', '*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      security,
    },
    rules: {
      ...security.configs.recommended.rules,
      // Sanctioned rule-offs (build-policy project-standards.md): both fire constantly on
      // legitimate dynamic-key and local_data path access in this codebase.
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
);
