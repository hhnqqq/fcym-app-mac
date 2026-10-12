#!/bin/bash
# 停止客户端并撤销系统代理
cd "$(dirname "$0")"

PID=$(cat harness.pid 2>/dev/null)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "停止客户端 (PID $PID) ..."
  kill -TERM "$PID" 2>/dev/null
  # 等待优雅退出（它会在退出前撤销系统代理）
  for i in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$PID" 2>/dev/null
  rm -f harness.pid
else
  rm -f harness.pid
  echo "客户端未在运行"
fi

# 兜底：确保系统自动代理已关闭（对所有常见网络服务）
for SVC in "Thunderbolt Bridge" "Wi-Fi" "Ethernet" "USB 10/100/1000 LAN" "Bluetooth PAN"; do
  networksetup -setautoproxystate "$SVC" off 2>/dev/null
done
echo "已撤销系统代理设置"
