FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p dist/uploads/manual-images dist/uploads/manual-videos

EXPOSE 3000

CMD ["npm", "run", "start"]
