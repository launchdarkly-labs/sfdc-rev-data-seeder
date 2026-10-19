// ROADMAP 0.4 — lean flat config: correctness rules only, formatting belongs to prettier.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.tsx', 'src/renderer/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    rules: {
      // Fidelity ports intentionally mirror Apex shapes; unused args in
      // interface impls are common — flag only clearly dead locals.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // jsforce payloads are untyped JSON at the edges; the engine keeps its
      // own types. Allow explicit any at I/O boundaries without ceremony.
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'writable',
        console: 'readonly',
        __dirname: 'readonly',
        process: 'readonly'
      }
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    // Trap 1 (transformMap §5): Apex `String ==` is case-insensitive. Under the
    // deploy engine, comparing a mapping strategy with a raw ===/!== silently
    // diverges on hand-edited casing (e.g. "DirectId") — use ciEquals() from
    // engine/deploy/transform/apexSemantics.
    files: ['src/main/engine/deploy/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Both === /!== AND loose == /!= : between two strings JS == is
          // case-sensitive too, so it has the identical Apex divergence, and
          // there is no eqeqeq backstop. Value regex is case-insensitive so a
          // mis-cased literal ("ExternalId") is caught as well. `== null` and
          // other non-strategy literals are unaffected.
          selector:
            "BinaryExpression[operator=/^(===|!==|==|!=)$/] > Literal[value=/^(externalId|nameMatch|directId|customId|setToMe|skip)$/i]",
          message:
            'Apex String == is case-insensitive; use ciEquals(...) for strategy-literal comparisons under engine/deploy/ (transformMap §5 trap 1).'
        }
      ]
    }
  }
)
