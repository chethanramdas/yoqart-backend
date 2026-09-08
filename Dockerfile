FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ghostscript ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages -U "yt-dlp[default]" pdf2docx PyMuPDF pdfplumber openpyxl python-docx pillow
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]
