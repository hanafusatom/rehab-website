<?php
/**
 * RehabCMS 保存エンドポイント
 *
 * 【初回設定手順】
 * 1. サイトをサーバーにアップロード
 * 2. ブラウザでページを開き、F12 → コンソールで以下を実行：
 *      window.cmsGetHash('あなたのパスワード')
 * 3. 表示されたSHA-256ハッシュ文字列を下の ALLOWED_HASH に貼り付ける
 * 4. cms-save.php を保存してサーバーに再アップロード
 *
 * 【ファイル権限】
 * cms-data.json が存在しない場合、このスクリプトが自動作成します。
 * 作成できない場合は以下を実行：
 *   touch cms-data.json && chmod 664 cms-data.json
 */

// ▼▼▼ ここにSHA-256ハッシュを貼り付ける ▼▼▼
define('ALLOWED_HASH', 'YOUR_SHA256_HASH_HERE');
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

define('DATA_FILE', __DIR__ . '/cms-data.json');

header('Content-Type: application/json; charset=utf-8');

// CORSヘッダー（同一ドメインなら不要だが念のため）
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
}

// プリフライトリクエスト対応
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// POSTのみ受け付ける
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// リクエストボディを読み込む
$body = file_get_contents('php://input');
$input = json_decode($body, true);

if (!is_array($input)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON']);
    exit;
}

// トークン認証
$token = isset($input['_token']) ? $input['_token'] : '';
if (ALLOWED_HASH === 'YOUR_SHA256_HASH_HERE') {
    http_response_code(503);
    echo json_encode(['error' => 'cms-save.php の ALLOWED_HASH が未設定です。初回設定を完了してください。']);
    exit;
}
if ($token !== ALLOWED_HASH) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// メタキー（_で始まるキー）を除いてデータを整形
$data = [];
foreach ($input as $key => $value) {
    if (strpos($key, '_') !== 0) {
        $data[$key] = $value;
    }
}
$data['_saved'] = date('c'); // 保存日時を記録

// ファイルに書き込む
$json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if (file_put_contents(DATA_FILE, $json, LOCK_EX) === false) {
    http_response_code(500);
    echo json_encode(['error' => 'ファイルへの書き込みに失敗しました。cms-data.json のパーミッションを確認してください。']);
    exit;
}

echo json_encode(['success' => true, 'saved' => $data['_saved']]);
