import tseslint from 'typescript-eslint'

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['src/**/*.ts'] })),
  {
    files: ['**/*.{js,mjs,ts}'],
    rules: { 'no-debugger': 'error', 'no-duplicate-imports': 'error', 'no-unreachable': 'error' },
  },
]
