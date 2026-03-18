# HTTP → HTTPS 설정 가이드 (모든 브라우저에서 접속 가능하게)

## 왜 HTTP 사이트가 안 열리나요?

- **Edge, Chrome 등**은 HTTP 주소를 "안전하지 않음"으로 표시하고, 일부 설정에서는 접속을 제한합니다.
- **해결 방법**: 사이트를 **HTTPS**로 제공하면 모든 브라우저에서 정상적으로 열립니다.

---

## 방법 1: Cloudflare Quick Tunnel (가장 쉬움, 도메인 불필요)

**도메인 없이** 몇 분 안에 HTTPS 주소를 받을 수 있습니다.

### 1) cloudflared 설치 (서버에서 한 번만)

**Ubuntu/Debian:**
```bash
# 최신 .deb 다운로드 (AMD64 기준)
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

**다른 OS:**  
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

### 2) Next.js는 그대로 3000 포트로 실행

```bash
cd /home/ubuntu/manufacturing-dashboard
npm run start   # 또는 npm run dev (개발 시)
```

### 3) 터널 실행 (새 터미널에서)

```bash
cloudflared tunnel --url http://localhost:3000
```

출력에 나오는 **https://xxxx-xx-xx-xx-xx.trycloudflare.com** 주소가 바로 HTTPS 주소입니다.  
이 주소를 Edge, Chrome, Safari 등 **어떤 브라우저에서든** 열면 됩니다.

- **참고**: Quick Tunnel은 재시작할 때마다 URL이 바뀝니다. 고정 URL이 필요하면 방법 2를 사용하세요.

---

## 방법 2: 도메인 + Nginx + Let's Encrypt (고정 URL, 프로덕션용)

이미 **도메인**이 있고, 그 도메인이 서버 IP(3.34.166.82)를 가리키고 있다면 아래처럼 하면 됩니다.

### 1) Nginx 설치

```bash
sudo apt update
sudo apt install nginx -y
```

### 2) Let's Encrypt 인증서 (Certbot)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d your-domain.com
```

(실제 도메인으로 `your-domain.com`을 바꾸세요.)

### 3) Nginx 사이트 설정 예시

`/etc/nginx/sites-available/manufacturing-dashboard`:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/manufacturing-dashboard /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

이후 Next.js는 `npm run start`로 3000 포트에서만 실행하고, 사용자는 **https://your-domain.com** 으로 접속하면 됩니다.

---

## 방법 3: IP만 있을 때 (자체 서명 인증서)

도메인이 없고 **IP(3.34.166.82)로만** HTTPS를 쓰려면 자체 서명 인증서를 쓸 수 있습니다.  
브라우저가 "연결이 비공개가 아닙니다"라고 한 번 경고하고, "고급" → "접속 계속"을 눌러야 합니다. (한 번 인증하면 같은 브라우저에서는 보통 다시 묻지 않습니다.)

### Caddy로 자동 HTTPS (자체 서명)

```bash
# Caddy 설치 (Ubuntu)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy -y

# 자체 서명으로 HTTPS (IP만 사용)
echo 'https://3.34.166.82 {
  tls internal
  reverse_proxy localhost:3000
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

이후 **https://3.34.166.82** 로 접속하면 됩니다. (경고 한 번 누르면 Edge 등에서도 접속 가능)

---

## 요약

| 상황 | 추천 방법 |
|------|-----------|
| 빠르게 모든 브라우저에서만 열리게 하기 | **방법 1: Cloudflare Quick Tunnel** |
| 도메인이 있음, 고정 URL 필요 | **방법 2: Nginx + Let's Encrypt** |
| 도메인 없고 IP로만 HTTPS 쓰기 | **방법 3: Caddy 자체 서명** |

가장 간단한 것은 **방법 1**입니다. 서버에 `cloudflared`만 설치한 뒤 `cloudflared tunnel --url http://localhost:3000` 을 실행하고, 출력되는 **https://….trycloudflare.com** 주소로 접속하면 됩니다.
