FROM node:20-alpine

# ffmpeg serve a estrarre un fotogramma dal flusso RTSP della telecamera
RUN apk add --no-cache ffmpeg tzdata
ENV TZ=Europe/Rome

WORKDIR /app
RUN npm install firebase-admin --omit=dev

COPY leggi-display.js .

CMD ["node", "leggi-display.js"]
