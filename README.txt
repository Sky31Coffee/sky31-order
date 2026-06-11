Sky31 V67 Mobile Optimized Clean

這版是重構清理版：
- index.html 從約 90KB 精簡到約 35KB 左右
- 刪除重複 function、重複 script、舊版補丁殘留
- 移除手機 Safari 容易卡頓的 backdrop-filter / 大量固定動畫
- 保留：點餐、購物車、Telegram 收單、完成訂單、已領取、訂單查詢、cart 明細顯示
- order.js 使用 waitUntil 優先返回，手機下單不再等 Telegram 卡住

GitHub 建議完整覆蓋：
- index.html
- functions/api/order.js
- functions/api/status.js
- functions/api/telegram-webhook.js

圖片檔案不用刪，保留原本 jpg/png 即可。
