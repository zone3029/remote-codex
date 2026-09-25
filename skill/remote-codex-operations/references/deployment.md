# 部署参考

Linux：在源码根目录运行 sudo bash deploy/install.sh。脚本会创建 remote-codex 系统用户、systemd 服务、随机控制端/注册令牌和自签名证书。生产环境应把 Nginx 或其他 HTTPS 反向代理放在 127.0.0.1:18765 前面。

Docker：复制 deploy/docker/.env.example 为 .env，运行 bash deploy/docker/generate-config.sh 生成随机令牌，再执行 docker compose -f deploy/docker/docker-compose.yml up -d --build。公网只暴露 HTTPS 代理和 RDP 端口段，不要直接公开控制端口。
