'use strict';

suite(tap, 'window', {timeout: 10000}, t => {
  t.test('should open the window and load local file', t => {
    let editorWin = new Editor.Window();
    editorWin.load('editor-framework://test/fixtures/simple.html');
    editorWin.nativeWin.webContents.on('dom-ready', () => {
      editorWin.close();
      t.end();
    });
  });

  t.test('should open the window and load remote web-site', t => {
    let editorWin = new Editor.Window();
    editorWin.load('http://www.baidu.com');

    t.equal( editorWin._url, 'http://www.baidu.com');
    editorWin.nativeWin.webContents.on('dom-ready', () => {
      editorWin.close();
      t.end();
    });
  });
});
