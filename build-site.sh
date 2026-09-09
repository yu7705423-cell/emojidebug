#!/bin/sh
# Cloudflare Pages 的构建命令。
#
# 直接把仓库根目录当输出目录也能跑，但那样 android/ 整个源码
# —— 包括加密过的签名密钥 —— 会挂在网站自己的域名下。
# 加密归加密，没必要顺手发给所有人。这里只挑网页真正要的那几个文件。
set -e
rm -rf dist
mkdir -p dist
cp index.html jszip.min.js html2canvas.min.js supabase.min.js dist/
echo "已放入 dist/："
ls -1 dist
