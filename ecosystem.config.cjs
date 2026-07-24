module.exports = {
  apps: [
    {
      name: 'debtflow-backend',
      script: 'backend/server.cjs',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      watch: false,
    },
    {
      name: 'debtflow-frontend',
      script: 'node_modules/vite/bin/vite.js',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      watch: false,
    },
  ],
};
