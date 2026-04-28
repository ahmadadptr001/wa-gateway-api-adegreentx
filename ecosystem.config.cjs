module.exports = {
  apps: [
    {
      name: "wa-gateway-api", // Nama proses di PM2
      script: "./index.js", // File utama yang dijalankan
      interpreter: "node", // Gunakan Node.js
    },
  ],
};
