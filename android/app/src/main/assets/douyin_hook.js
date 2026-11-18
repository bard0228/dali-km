(function () {
  if (window.__daliHooked) return;
  window.__daliHooked = true;
  function report(url, text) {
    try {
      if (!text || (text.indexOf('play_addr') < 0 && text.indexOf('"images"') < 0)) return;
      if (text.indexOf('aweme_detail') < 0 && text.indexOf('item_list') < 0 && text.indexOf('aweme_list') < 0) return;
      if (window.DaliDouyinBridge && window.DaliDouyinBridge.onData) {
        window.DaliDouyinBridge.onData(String(url), text);
      }
    } catch (e) {}
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var args = arguments;
      return origFetch.apply(this, args).then(function (resp) {
        try {
          resp.clone().text().then(function (t) { report(resp.url || args[0], t); });
        } catch (e) {}
        return resp;
      });
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__daliUrl = u;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener('load', function () {
      try {
        var t = xhr.responseType === '' || xhr.responseType === 'text'
          ? xhr.responseText
          : (xhr.responseType === 'json' ? JSON.stringify(xhr.response) : '');
        report(xhr.__daliUrl, t);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
