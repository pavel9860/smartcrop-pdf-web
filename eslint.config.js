import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.worker.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // requireEl<E>'s generic is intentionally single-use: like DOM lib's own
    // querySelector<E>(), E is inferred from the call site's assignment target,
    // not from any parameter. That's the entire point of the helper (spec'd in
    // ARCHITECTURE.md ui/ section) — substituting the constraint would force
    // every one of its ~40 call sites back onto manual `as` casts.
    files: ['src/ui/dom.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    // Test code legitimately reaches into the DOM with `el.querySelector(...)!` and casts
    // hand-rolled mocks/duck-typed stubs (browser globals, AppController) through `any`/
    // `unknown`. Enforcing production strictness there adds noise without catching real bugs;
    // relax only the rules that fire purely from those test idioms.
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.js', '*.config.ts'],
  },
)
