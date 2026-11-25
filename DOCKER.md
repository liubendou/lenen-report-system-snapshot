# Docker 镜像部署说明

应用零依赖（纯 Node 内置模块），镜像构建只是"把文件夹装进 Node 基础镜像"，10 秒完成。

## 前提
- 服务器已装 Docker（Linux：`curl -fsSL https://get.docker.com | sh`）
- 本文件夹完整拷贝到服务器（含 Dockerfile / docker-compose.yml / lib / public / server.js / backup.js）

## 方式一：docker compose（推荐）
```bash
cd lenen
docker compose up -d --build     # 构建并后台启动
docker compose logs -f           # 看启动日志（Ctrl+C 退出，不影响服务）
```
浏览器访问 `http://<服务器IP>:8800`，初始账号 `admin / change-me-on-first-login`，首登强制改密。

## 方式二：纯 docker 命令
```bash
docker build -t lenen-checkin .
docker run -d --name lenen --restart unless-stopped -p 8800:8800 -v "$PWD/data:/app/data" lenen-checkin
```

## 数据在哪
- 全部数据（SQLite 库、报到照片、自动备份）都在容器的 `/app/data`，compose 已映射到宿主机 `./data`
- 升级版本：换源码后 `docker compose up -d --build`，数据不动
- 手动备份：`docker exec lenen node backup.js`（落到 data/backups/，保留 30 份）
- 迁移服务器：直接拷走 `data` 文件夹即可

## 常用运维
```bash
docker compose ps                # 状态（含健康检查）
docker compose restart           # 重启
docker compose down              # 停止并删容器（data 保留）
```

## 云服务器访问不了的排查顺序
1. 应用是否活着：服务器上 `curl -I http://127.0.0.1:8800` 应返回 200
2. 系统防火墙：`netsh advfirewall firewall add rule name="lenen" dir=in action=allow protocol=TCP localport=8800`（Windows）或 `firewall-cmd --add-port=8800/tcp --permanent && firewall-cmd --reload`（Linux）
3. **云厂商安全组**（最容易漏）：控制台 → 安全组/防火墙 → 入方向放行 TCP 8800
4. 外部测试：浏览器开 `http://<公网IP>:8800`
