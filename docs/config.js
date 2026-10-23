// セットアップ後に書き換える
window.APP_CONFIG = {
  LIFF_ID: '2012174471-uueIemYH',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbycAB4zsi3_re8EhgNcsZZVB0GnhxV93QAvVzGQQjRFLnCqfWjD29WY7vbONyQhh3o7xg/exec',
  // 公式アカウントの友だち追加URL (例: https://line.me/R/ti/p/@123abcde)
  ADD_FRIEND_URL: 'https://lin.ee/z7TNXoo',
};

// GAS は CORS プリフライトに対応しないため text/plain で送る
window.callApi = async function (payload) {
  const res = await fetch(window.APP_CONFIG.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.data;
};
