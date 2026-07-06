module.exports = {
  apps: [
    {
      name: 'debtflow-backend',
      script: 'backend/server.cjs',
      cwd: 'C:/Users/hjbae/OneDrive - 바로고/문서/클로드 코드 에이전트/채권관리 시스템',
      interpreter: 'node',
      autorestart: true,
      watch: false,
    },
    {
      name: 'debtflow-frontend',
      script: 'node_modules/vite/bin/vite.js',
      cwd: 'C:/Users/hjbae/OneDrive - 바로고/문서/클로드 코드 에이전트/채권관리 시스템',
      interpreter: 'node',
      autorestart: true,
      watch: false,
    },
  ],
};
