FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build && mkdir -p uploads/dni

EXPOSE 3000

CMD ["npm", "run", "start"]
