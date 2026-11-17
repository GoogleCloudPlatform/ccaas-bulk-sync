# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Stage 1: Build the application
FROM node:22-slim AS builder

WORKDIR /usr/src/app

# Install exactly what package-lock.json specifies (including dev dependencies
# for the CSS build).
COPY package*.json ./
RUN npm ci --no-fund --no-audit

# Copy the rest of the application source code
COPY . .

# Build the production CSS and the precompiled Vue template, then drop dev
# dependencies.
RUN npm run build && npm prune --omit=dev --no-fund --no-audit

# Stage 2: Create the final production image
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Copy only the necessary files from the builder stage, owned by root and
# read-only for the runtime user.
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/public ./public
# Copy every top-level application module (index.js, auth.js, sync-*.js, ...).
COPY --from=builder /usr/src/app/*.js ./

# Run as the unprivileged "node" user that the official image provides.
USER node

EXPOSE 8080

CMD [ "node", "index.js" ]
