/**
 * 사이트맵을 사람이 볼 수 있게 하는 스타일시트.
 *
 * 브라우저로 sitemap_index.xml 을 열면 XML 날것 대신 표가 나온다.
 * 네이버·구글 봇은 이걸 무시하고 XML 을 그대로 읽으므로 색인에는 영향이 없다.
 *
 * 레퍼런스(Yoast)가 하는 그대로다 — 운영자가 그 화면을 보고 요청했다.
 */
export const SITEMAP_XSL = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
<xsl:output method="html" encoding="UTF-8" indent="yes"/>

<xsl:template match="/">
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,follow"/>
<title>XML 사이트맵</title>
<style>
:root{--ink:#1b2327;--mute:#5a666c;--line:#dfe3e6;--bg:#f7f8f9;--acc:#17564f}
*{box-sizing:border-box}
body{margin:0;padding:28px 18px 60px;background:var(--bg);color:var(--ink);
  font:15px/1.7 "Noto Sans KR",system-ui,-apple-system,sans-serif}
.w{max-width:960px;margin:0 auto}
h1{font-size:22px;font-weight:800;margin:0 0 10px}
p.d{color:var(--mute);margin:0 0 6px}
p.c{color:var(--mute);margin:0 0 22px;font-size:14px}
a{color:var(--acc)}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line)}
th,td{padding:11px 14px;border-bottom:1px solid var(--line);text-align:left;
  font-size:14px;vertical-align:top;word-break:break-all}
th{background:var(--ink);color:#fff;font-weight:700;font-size:13px;letter-spacing:.04em;
  white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:nth-child(even) td{background:#fbfcfc}
td.n{white-space:nowrap;color:var(--mute);width:1%}
</style>
</head>
<body><div class="w">

<xsl:if test="sm:sitemapindex">
  <h1>XML 사이트맵 색인</h1>
  <p class="d">검색엔진이 읽는 파일입니다. 사람이 보시라고 표로 바꿔 두었습니다.</p>
  <p class="c">사이트맵 <xsl:value-of select="count(sm:sitemapindex/sm:sitemap)"/>개</p>
  <table>
    <tr><th>사이트맵</th><th>마지막 수정</th></tr>
    <xsl:for-each select="sm:sitemapindex/sm:sitemap">
      <tr>
        <td><a href="{sm:loc}"><xsl:value-of select="sm:loc"/></a></td>
        <td class="n"><xsl:value-of select="sm:lastmod"/></td>
      </tr>
    </xsl:for-each>
  </table>
</xsl:if>

<xsl:if test="sm:urlset">
  <h1>XML 사이트맵</h1>
  <p class="d">검색엔진이 읽는 파일입니다. 사람이 보시라고 표로 바꿔 두었습니다.</p>
  <p class="c">주소 <xsl:value-of select="count(sm:urlset/sm:url)"/>개</p>
  <table>
    <tr><th>주소</th><th>마지막 수정</th></tr>
    <xsl:for-each select="sm:urlset/sm:url">
      <tr>
        <td><a href="{sm:loc}"><xsl:value-of select="sm:loc"/></a></td>
        <td class="n"><xsl:value-of select="sm:lastmod"/></td>
      </tr>
    </xsl:for-each>
  </table>
</xsl:if>

</div></body>
</html>
</xsl:template>
</xsl:stylesheet>
`;
