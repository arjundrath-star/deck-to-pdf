const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  mode: "production",
  entry: {
    content: "./src/content.ts",
    background: "./src/background.ts",
    popup: "./src/popup.ts",
    // Generic mode: injected on demand via chrome.scripting.executeScript,
    // never declared in manifest content_scripts.
    "generic-collector": "./src/generic-collector.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
    // core/ modules import each other with .js specifiers so the same source
    // also compiles standalone (tsc) for the Node/browser test harness.
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json" },
        { from: "popup.html" },
        // Flat package: icon files at dist root, matching the manifest paths.
        // Keep it flat so re-zipping pipelines cannot break the icon paths.
        { from: "icons", to: "." },
      ],
    }),
  ],
  optimization: {
    minimize: false,
  },
};
