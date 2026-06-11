Sky31 V58 Frontend Cart Display Fix

修正內容：
- 查詢頁強制讀取 API 返回的 cart
- 顯示飲品名稱、中文名、數量、豆子、風味、冷熱、冰量、奶類、備註
- fetch 加 no-store 和時間參數，減少瀏覽器快取問題
- 保留展開/收起和滑動查詢結果

GitHub 最少只需要覆蓋：index.html
如果 status.js 未更新，也要同時覆蓋 functions/api/status.js
