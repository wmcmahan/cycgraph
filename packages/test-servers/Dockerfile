# Scenario servers for the playground and the gated a2a composition suite.
#
# Standalone by design: this package depends on nothing else in the workspace,
# so it installs from its own package.json rather than needing the repo root.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --no-package-lock

COPY src ./src

EXPOSE 4001 4002

CMD ["npx", "tsx", "src/cli.ts"]
