#!/bin/bash
# 启动风车云马系统级客户端
cd "$(dirname "$0")"

if [ -f harness.pid ] && kill -0 "$(cat harness.pid)" 2>/dev/null; then
  echo "已在运行 (PID $(cat harness.pid))，状态: http://127.0.0.1:8931/status"
  exit 0
fi

if [ ! -f state.json ]; then
  echo "首次运行：正在从 Edge 提取登录凭证 ..."
  node extract.mjs || exit 1
fi

echo "启动中 ..."
FCYM_DEBUG=${FCYM_DEBUG:-} nohup node harness.mjs > run.log 2>&1 &
echo $! > harness.pid

# 等待 PAC 就绪（最多 60 秒）
for i in $(seq 1 60); do
  if curl -s --max-time 2 http://127.0.0.1:8931/status 2>/dev/null | grep -q '"ok": *true'; then
    echo
    echo "✓ 系统级代理已生效 (PID $(cat harness.pid))"
    echo "  状态:   http://127.0.0.1:8931/status"
    echo "  节点:   curl -s http://127.0.0.1:8931/nodes"
    echo "  切换:   curl -s 'http://127.0.0.1:8931/select?id=19'"
    echo "  停止:   ./stop.sh"
    exit 0
  fi
  sleep 1
done

echo "启动超时，最近日志:"
tail -20 run.log
exit 1
