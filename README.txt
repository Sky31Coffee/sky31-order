Sky31 V63 Checkout Exit Fix

修正內容：
- 修復手機按確認訂單後卡在 checkout 畫面
- 成功下單後顯示訂單號
- 自動清空購物車
- 自動關閉確認訂單視窗
- 按鈕會恢復可點擊狀態
- fetch 加 12 秒 timeout，避免前端長時間卡死

GitHub 最少只需要覆蓋：
- index.html

如果仍有手機提交問題，請同時覆蓋 V62 的 functions/api/order.js。
