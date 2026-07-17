# Dev-oriented image: run the Vite server so the container mirrors local dev.
# (A production build would compile static assets and serve via nginx.)
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
