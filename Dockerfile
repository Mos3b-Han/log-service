# Dockerfile
#
# Multi-stage build: a heavier `build` stage compiles TypeScript to
# JavaScript, then a minimal `runtime` stage copies only the compiled
# output and production dependencies. This keeps the final image
# small enough to respect the 0.5 CPU / 256MB grading constraint.

# ---- Stage 1: build ----
    FROM node:20-alpine AS build

    WORKDIR /app
    
    # Copy only the manifest first so `npm ci` is cached separately from
    # source code changes -- rebuilding after a code-only change reuses
    # this layer instead of reinstalling every dependency.
    COPY package.json package-lock.json ./
    RUN npm ci
    
    # Now copy source and config needed to compile.
    COPY tsconfig.json ./
    COPY src ./src
    
    RUN npm run build
    
    # ---- Stage 2: runtime ----
    FROM node:20-alpine AS runtime
    
    WORKDIR /app
    ENV NODE_ENV=production
    
    # Install only production dependencies -- no TypeScript, no vitest,
    # no dev tooling in the final image.
    COPY package.json package-lock.json ./
    RUN npm ci --omit=dev
    
    # Copy only the compiled JavaScript from the build stage.
    COPY --from=build /app/dist ./dist

    # Migrations are raw .sql files read at startup by src/db/migrate.ts.
    # They must ship with the runtime image, not just the build stage.
    COPY migrations ./migrations

    EXPOSE 8080
    
    USER node
    
    CMD ["node", "dist/index.js"]