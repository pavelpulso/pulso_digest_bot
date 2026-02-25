module.exports = {
  apps: [{
    name: "tg-digest-bot",
    script: "src/index.js",
    watch: false,
    max_memory_restart: "200M",
    env_file: ".env"
  }]
};
