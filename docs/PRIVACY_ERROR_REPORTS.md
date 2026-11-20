# Error reports — privacy paragraph for atomvs.com/privacy

Paste into the "Error reports" section of https://www.atomvs.com/privacy (synkro-web repo). The app's
Settings → Privacy links there.

## English

**Error reports.** When a preview, a Cloud Build or one of the agent's tools fails, Atomvs can send an error report
to our error-tracking service (Sentry) so we can find and fix the problem. A report contains the kind of failure,
the step where it happened, the Atomvs version, your operating system and version, the framework (Flutter or React
Native) and a short, cleaned error message. It never contains your code, file contents, prompts or chat, API keys,
passwords, tokens or your e-mail address: before a report leaves your computer, Atomvs removes keys and tokens,
e-mail addresses, and every local path except the file name (so `C:\Users\you\shop\lib\main.dart` becomes
`main.dart`). Reports are not linked to your account and do not include your computer's name or IP-based location.
For Cloud Builds, the report is sent by our build server with the same cleaning, and only the failed step and the
first error line of the build log, never the log itself. Reports are kept for 90 days. You can turn error reports
off at any time in Settings → Privacy → "Send error reports"; nothing is sent from your computer while it is off.

## العربية

**تقارير الأخطاء.** لما تفشل المعاينة أو Cloud Build أو إحدى أدوات الوكيل، يمكن لـ Atomvs أن يرسل تقرير خطأ إلى خدمة
تتبّع الأخطاء (Sentry) حتى نعرف المشكلة ونصلحها. يحتوي التقرير على نوع الفشل، والخطوة التي حدث فيها، ونسخة Atomvs،
ونظام التشغيل ونسخته، والإطار (Flutter أو React Native)، ورسالة خطأ قصيرة منظّفة. لا يحتوي أبداً على الكود أو محتوى
الملفات أو الطلبات والمحادثة أو مفاتيح API أو كلمات المرور أو الرموز أو بريدك الإلكتروني: قبل أن يغادر التقرير جهازك،
يحذف Atomvs المفاتيح والرموز وعناوين البريد وكل مسار محلي ما عدا اسم الملف (فيصبح `C:\Users\you\shop\lib\main.dart`
مجرد `main.dart`). التقارير غير مربوطة بحسابك ولا تتضمن اسم جهازك ولا موقعك من عنوان IP. في Cloud Build يرسل خادم
البناء التقرير بنفس التنظيف، ويرسل فقط الخطوة التي فشلت وأول سطر خطأ من سجل البناء، وليس السجل نفسه. تُحفظ التقارير
90 يوماً. يمكنك إيقاف تقارير الأخطاء في أي وقت من الإعدادات ← الخصوصية ← "إرسال تقارير الأخطاء"؛ ولا يُرسل شيء من
جهازك وهي متوقفة.

## Türkçe

**Hata raporları.** Bir önizleme, bir Cloud Build veya ajanın araçlarından biri başarısız olduğunda Atomvs, sorunu
bulup düzeltebilmemiz için hata izleme hizmetimize (Sentry) bir hata raporu gönderebilir. Rapor; hatanın türünü,
gerçekleştiği adımı, Atomvs sürümünü, işletim sisteminizi ve sürümünü, framework'ü (Flutter veya React Native) ve
kısa, temizlenmiş bir hata mesajını içerir. Kodunuzu, dosya içeriklerini, istemlerinizi veya sohbetinizi, API
anahtarlarını, parolaları, token'ları veya e-posta adresinizi asla içermez: rapor bilgisayarınızdan çıkmadan önce
Atomvs anahtarları ve token'ları, e-posta adreslerini ve dosya adı dışındaki tüm yerel yolları siler
(`C:\Users\you\shop\lib\main.dart` yalnızca `main.dart` olur). Raporlar hesabınıza bağlanmaz; bilgisayarınızın adını
veya IP tabanlı konumunuzu içermez. Cloud Build'lerde rapor, aynı temizlikle derleme sunucumuz tarafından gönderilir
ve derleme günlüğünün kendisi değil, yalnızca başarısız adım ve ilk hata satırı gönderilir. Raporlar 90 gün saklanır.
Hata raporlarını istediğiniz zaman Ayarlar → Gizlilik → "Hata raporları gönder" bölümünden kapatabilirsiniz; kapalıyken
bilgisayarınızdan hiçbir şey gönderilmez.

## Notes for whoever publishes this

- 90 days must match the Sentry project's data retention setting (Settings → Security & Privacy → Data retention).
  In the Sentry project, also turn on "Prevent storing of IP addresses" and keep "Data scrubber" on (a second layer
  behind the app's own scrubbing).
- The cleaning described here is `scrubEvent` / `scrubString` in `packages/shared/src/error-report.ts`, tested in
  `packages/agent/tests/error-report.test.ts`. Change the text if that code changes.
