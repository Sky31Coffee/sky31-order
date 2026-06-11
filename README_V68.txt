Sky31 V68 Mobile Submit + Bean Recommendation Fix

基於你上傳的 sky31-order-main 完整版本修改。

修正內容：
- 保留現有 Landing Page / 主頁 / 菜單 / 查詢 / Telegram 功能
- 修復 iPhone Safari 下單後卡在提交中
- 成功後不再使用 alert + reload，改為自訂成功彈窗
- 成功後自動清空購物車、關閉 checkout
- 加回菜單豆子推薦字眼：美式推薦淺烘；奶咖/Dirty/摩卡推薦中深烘

GitHub 只需要覆蓋：
- index.html

後端 order.js/status.js/telegram-webhook.js 不需要改。
