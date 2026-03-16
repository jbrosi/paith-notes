module.exports = {
  extends: ["stylelint-config-standard"],
  rules: {},
  overrides: [
    {
      // CSS Modules use camelCase class names so they can be accessed as JS properties
      // (e.g. styles.iconButton). Disable the kebab-case enforcement for module files.
      files: ["**/*.module.css"],
      rules: {
        "selector-class-pattern": null,
      },
    },
  ],
};
