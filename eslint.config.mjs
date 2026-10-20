import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next >= 16 ships native flat configs, so they are spread
// directly instead of being adapted through @eslint/eslintrc/FlatCompat.
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { ignores: [".next/**", "node_modules/**", "data/**", "coverage/**", "next-env.d.ts"] },
];

export default config;
