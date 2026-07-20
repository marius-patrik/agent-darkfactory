/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/views/**/*.tsx", "./src/components/**/*.tsx"],
  theme: {
    extend: {
      colors: {
        vsdaw: {
          bg: "var(--vsdaw-bg)",
          fg: "var(--vsdaw-fg)",
          panel: "var(--vsdaw-panel-bg)",
          sidebar: "var(--vsdaw-sidebar-bg)",
          button: "var(--vsdaw-button-bg)",
          "button-fg": "var(--vsdaw-button-fg)",
          input: "var(--vsdaw-input-bg)",
          border: "var(--vsdaw-border)",
          focus: "var(--vsdaw-focus)",
          error: "var(--vsdaw-error)",
          warning: "var(--vsdaw-warning)",
        },
      },
    },
  },
  plugins: [],
};
