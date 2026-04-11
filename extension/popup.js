chrome.runtime.sendMessage({ type: 'get_status' }, (res) => {
  const el = document.getElementById('status');
  if (res?.connected) {
    el.textContent = 'Conectado ao Electron';
    el.className = 'on';
  } else {
    el.textContent = 'Desconectado';
    el.className = 'off';
  }
});
