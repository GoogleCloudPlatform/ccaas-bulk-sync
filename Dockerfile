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

# Copy package files and install all dependencies (including dev)
COPY package*.json ./
RUN npm install

# Copy the rest of the application source code
COPY . .

# Build the production CSS file
RUN npm run build:css

# Stage 2: Create the final production image
FROM node:22-slim

WORKDIR /usr/src/app

# Copy only the necessary files from the builder stage
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/index.js ./
COPY --from=builder /usr/src/app/sync-logic.js ./

EXPOSE 8080

CMD [ "node", "index.js" ]

