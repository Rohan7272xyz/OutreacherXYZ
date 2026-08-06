FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all scripts and credentials
COPY *.js ./
COPY *.json ./

# Run the pipeline
CMD ["node", "daily-pipeline.js"]
