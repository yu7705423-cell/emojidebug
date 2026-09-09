package io.github.yu7705423cell.yoww;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 一层很薄的外壳：界面全是网页，装的这个 APK 只负责把 WebView 缺的那几件事补回来。
 *
 * 网页从线上加载而不是打包进来 —— 推一次 GitHub Pages，所有人下次打开就是新版，
 * 不用重新打包、重新签名、让整个群再装一遍。
 */
public class MainActivity extends AppCompatActivity {

  /** 站点地址。换域名只要改这一行。 */
  private static final String SITE = "https://yu7705423-cell.github.io/emojidebug/";

  private WebView web;
  private ValueCallback<Uri[]> filePicker;
  private static final int REQ_FILE = 1001;

  /** 正在写的文件，键是发给网页的 token */
  private final Map<String, OutputStream> writing = new HashMap<>();
  private final Map<String, Uri> writingUri = new HashMap<>();
  private final AtomicInteger tokenSeq = new AtomicInteger(1);

  @Override protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    web = new WebView(this);
    setContentView(web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);          // localStorage / IndexedDB，仓库整个功能都靠它
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setMediaPlaybackRequiresUserGesture(false);   // 「其他」里的铃声要能点一下就响
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

    web.addJavascriptInterface(new Bridge(), "YowwHost");

    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
        Uri u = req.getUrl();
        String url = u.toString();
        // 站内的留在 App 里；管理员通知里的红包链接那种外站地址交给系统浏览器，
        // 否则用户点进去就再也回不到 App 了
        if (url.startsWith(SITE)) return false;
        openOutside(u);
        return true;
      }
      @Override public void onPageFinished(WebView v, String url) {
        v.evaluateJavascript(DOWNLOAD_HOOK, null);
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                                 FileChooserParams params) {
        // 不接这个回调，网页里所有 <input type=file>（换头像、导入 txt/docx）
        // 点了都毫无反应，而且不报错
        if (filePicker != null) filePicker.onReceiveValue(null);
        filePicker = cb;
        Intent i = params.createIntent();
        i.addCategory(Intent.CATEGORY_OPENABLE);
        try {
          startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
        } catch (ActivityNotFoundException e) {
          filePicker = null;
          toast("这台设备上没有能选文件的应用");
          return false;
        }
        return true;
      }
    });

    // blob:/data: 之外的直链下载还是交给系统下载器
    web.setDownloadListener((url, ua, disposition, mime, len) -> {
      if (url.startsWith("blob:") || url.startsWith("data:")) return;   // 由注入的脚本接管
      try {
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
        r.setMimeType(mime);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        r.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS,
            android.webkit.URLUtil.guessFileName(url, disposition, mime));
        ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
        toast("开始下载");
      } catch (Exception e) {
        toast("下载失败：" + e.getMessage());
      }
    });

    // 网页自己用 pushState 管弹层的返回，所以交给 WebView 的历史就对了
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override public void handleOnBackPressed() {
        if (web.canGoBack()) web.goBack();
        else { setEnabled(false); getOnBackPressedDispatcher().onBackPressed(); }
      }
    });

    if (saved == null) web.loadUrl(SITE);
    else web.restoreState(saved);
  }

  @Override protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  private void openOutside(Uri u) {
    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); }
    catch (ActivityNotFoundException e) { toast("没有能打开这个链接的应用"); }
  }

  private void toast(String msg) {
    runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
  }

  @Override protected void onActivityResult(int req, int result, Intent data) {
    if (req != REQ_FILE) { super.onActivityResult(req, result, data); return; }
    if (filePicker == null) return;
    filePicker.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
    filePicker = null;
  }

  /**
   * 网页里那两处下载都是「建一个 a[download]，href 指向 blob:，然后 click()」。
   * WebView 碰到 blob: 会走 DownloadListener，而系统下载器根本取不到 blob: —— 
   * 表现就是点了保存什么都没发生。所以在捕获阶段把这种点击拦下来自己存。
   *
   * 分块传：仓库备份是几十兆的 zip，整包转成一个 base64 字符串塞过 JS 桥
   * 很容易直接把 App 撑爆。每块 300000 字节是 3 的倍数，保证每块都能独立解码，
   * Java 那边收一块写一块，内存是常数。
   */
  private static final String DOWNLOAD_HOOK =
      "(function(){"
    + "if(window.__yowwDl) return; window.__yowwDl=1;"
    + "async function send(blob,name){"
    + "  var t=YowwHost.beginSave(name, blob.type||'application/octet-stream');"
    + "  if(!t){ return; }"
    + "  try{"
    + "    var CH=300000;"
    + "    for(var off=0; off<blob.size; off+=CH){"
    + "      var u8=new Uint8Array(await blob.slice(off,off+CH).arrayBuffer());"
    + "      var bin=''; for(var i=0;i<u8.length;i++) bin+=String.fromCharCode(u8[i]);"
    + "      if(!YowwHost.appendChunk(t, btoa(bin))){ YowwHost.endSave(t,false); return; }"
    + "    }"
    + "    YowwHost.endSave(t,true);"
    + "  }catch(e){ YowwHost.endSave(t,false); }"
    + "}"
    + "document.addEventListener('click', function(e){"
    + "  var a=e.target && e.target.closest ? e.target.closest('a[download]') : null;"
    + "  if(!a) return;"
    + "  var href=a.getAttribute('href')||'';"
    + "  if(!/^(blob:|data:)/i.test(href)) return;"
    + "  e.preventDefault(); e.stopPropagation();"
    + "  var name=a.getAttribute('download')||'download';"
    + "  fetch(href).then(function(r){return r.blob();}).then(function(b){return send(b,name);});"
    + "}, true);"
    + "})();";

  private class Bridge {
    @JavascriptInterface public String beginSave(String name, String mime) {
      try {
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, safeName(name));
        v.put(MediaStore.Downloads.MIME_TYPE, mime == null ? "application/octet-stream" : mime);
        v.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) { toast("保存失败：系统没有给出可写位置"); return null; }
        OutputStream os = getContentResolver().openOutputStream(uri);
        if (os == null) { toast("保存失败：打不开文件"); return null; }
        String t = "t" + tokenSeq.getAndIncrement();
        writing.put(t, os);
        writingUri.put(t, uri);
        return t;
      } catch (Exception e) {
        toast("保存失败：" + e.getMessage());
        return null;
      }
    }

    @JavascriptInterface public boolean appendChunk(String token, String b64) {
      OutputStream os = writing.get(token);
      if (os == null) return false;
      try { os.write(Base64.decode(b64, Base64.DEFAULT)); return true; }
      catch (Exception e) { return false; }
    }

    @JavascriptInterface public void endSave(String token, boolean ok) {
      OutputStream os = writing.remove(token);
      Uri uri = writingUri.remove(token);
      try { if (os != null) os.close(); } catch (Exception ignored) {}
      if (uri == null) return;
      if (ok) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.IS_PENDING, 0);
        getContentResolver().update(uri, v, null, null);
        toast("已保存到「下载」");
      } else {
        // 半截文件留在下载目录里比没存下来更糟，删掉
        try { getContentResolver().delete(uri, null, null); } catch (Exception ignored) {}
        toast("保存失败");
      }
    }
  }

  /** 文件名里带路径分隔符会让 MediaStore 直接抛异常 */
  private static String safeName(String name) {
    String n = (name == null || name.trim().isEmpty()) ? "download" : name.trim();
    return n.replaceAll("[/\\\\:*?\"<>|]", "_");
  }
}
