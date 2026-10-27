# النشر التلقائي لـ PalCert بعد الدمج

الحالة: **تجهيز غير مفعّل**. هذا التغيير يجهّز مشغّل الإصدار، واختبار الصور المنشورة،
ونقل طلب النشر عبر SSH، وبوابة الخادم المحدودة. ربط خطوات النسخ الاحتياطي والتفريغ
والترقية بتركيب الإنتاج الفعلي ما زال يحتاج جرد الخادم واختباره. لا تكفي إضافة مفتاح
SSH أو تغيير متغير التفعيل لإكماله. لا توجد hooks وهمية تعيد النجاح.

## المسار المجهّز

1. Push إلى `main` يشغّل `Release`، الذي يستدعي **جميع** بوابات `ci.yml` على الالتزام
   نفسه. CI المباشر يستثني push إلى main فقط لمنع تشغيل البوابات مرتين؛ فحوص PR باقية.
2. بناء الصور الخمس، فحص التبعيات والثغرات والأسرار، SBOM، provenance، تجميد manifest،
   ورفع سجل الإصدار الإلزامي تبقى شروطًا للنجاح. لم يُخفّض أي حد اختبار.
3. عند تفعيل المتغير أدناه، تشغيل الصور المنشورة **بالبصمات نفسها** في stack تجريبي
   مؤقت مستقل على GitHub، مع `deploy.sh` وفحص الهوية و`staging-smoke.sh`، ثم تسجيل
   staging evidence. لا تنقل بيانات إنتاج إلى مشغّل GitHub.
4. قبل النشر، قراءة GitHub للتحقق أن الالتزام ما زال main وأنه ناتج دمج PR فعلي؛
   تسجيل من دمج PR. الدفع المباشر، وPR غير مدمج، ونسخة main قديمة، وtag أو تشغيل
   يدوي لا يفعّلون هذا المسار. لا يُختلق اسم موافق لتجاوز مراجعة.
5. مستخدم SSH مخصص يملك أمرًا مقيدًا واحدًا. يُرسل JSON فقط؛ لا shell عام، ولا ملفات
   مصدر أو سكربتات قادمة من Actions ينفذها root على الخادم. يتحقق الخادم مجددًا من
   main وPR ونجاح build/staging لدى GitHub قبل قبول الطلب.
6. قفل على الخادم وقفل `deploy-production` يمنعان تداخل النشر. لا نلغي نشرًا بدأ.
   الإعادة لنفس manifest الناجح تعيد الإيصال الأصلي دون تكرار migrations.

## إعدادات الخادم المحفوظة

- SSH الحالي للمشغّل: `raed@108.165.128.31`، بمفتاحه الشخصي الموجود لديه.
- المشروع `palcert-prod`، والمجلد `/opt/palcert/docker`؛ `/opt/palcert` ليس Git checkout.
- `/etc/palcert/production.env` و`/etc/palcert/ai.env` لا يرفعان إلى GitHub.
  يبقى ملف AI خاصًا بـroot وصلاحياته `600`.
- يجب استخدام ملفات Compose الثلاثة معًا:
  `/opt/palcert/docker/docker-compose.production.yml`،
  `/etc/palcert/docker-compose.origin-tls.yml`،
  `/opt/palcert/docker/docker-compose.ai.yml`.
- الحفاظ على TLS والشبكات وAnthropic/`claude-opus-5` ومهلة proxy المناسبة.
- عدم نسخ `docker-compose.release.yml` فوق ملفات الإنتاج؛ يستخدم في التجربة المؤقتة فقط.

## الخطوة الحالية: جرد للقراءة فقط

نفّذ `inventory.py` من هذا الالتزام بعد تنزيله ومراجعة بصمته، عبر جلسة SSH الحالية:

```bash
sudo python3 /path/to/inventory.py
```

يعرض أسماء الخدمات والصور والشبكات والـmounts والمنافذ وصلاحيات الملفات، دون طباعة
الأسرار أو أوامر الخدمات أو محتويات env. لا يغيّر إعدادًا ولا يوقف حاوية. أرسل هذا
الجرد لمراجعة adapter. **لا ترسل ناتج `docker compose config` الخام**: قد يحتوي أسرارًا.

بعد الجرد، يلزم تحديد موقع النسخ الاحتياطية المعتمد وسعة التخزين وطريقة قطع استقبال
العمل الجديد وانتظار الأعمال الجارية. لا نخمنها من تركيب stack التجريبي.

## إعداد GitHub مرة واحدة

في [Settings → Environments](https://github.com/palcertcom/palcert/settings/environments)،
أنشئ أو راجع بيئة `production` واجعل النشر منها مقصورًا على فرع `main`.
تحقق من إعدادات مراجعة PR وحماية main وفق سياسة المشروع. إذا أبقيت required reviewers
على بيئة production سيظل هناك انتظار موافقة لكل نشر؛ التشغيل التلقائي بالكامل يعتمد
مراجعة PR والدمج قرارًا للنشر. لا يغيّر هذا العمل إعدادات الحماية تلقائيًا.

متغيرات البيئة `production`:

| الاسم | القيمة |
|---|---|
| `PALCERT_DEPLOY_HOST` | `108.165.128.31` |
| `PALCERT_DEPLOY_PORT` | `22`، بعد تأكيد منفذ SSH |
| `PALCERT_DEPLOY_USER` | `palcert-deploy` بعد تثبيته |

أسرار البيئة `production`:

| الاسم | المحتوى |
|---|---|
| `PALCERT_DEPLOY_KEY` | المفتاح الخاص الجديد المخصص للنشر؛ يُدخل مباشرة إلى GitHub |
| `PALCERT_DEPLOY_KNOWN_HOSTS` | سطر host key موثّق عبر جلسة SSH الحالية الموثوقة |

متغير **المستودع** `PALCERT_AUTO_DEPLOY`: أبقه غير موجود أو `false` حتى إكمال جميع
الخطوات والتحقق. ليس متغير بيئة؛ يُقرأ قبل دخول job إلى بيئة production.

لا تستخدم المفتاح الشخصي ولا تضف حساب النشر إلى مجموعة Docker. مفتاح البيئة يُكشف
فقط لوظيفة production؛ مرحلة staging لا تحتاجه. لا تطبع المفاتيح في المحادثة أو logs.

## مفتاح جديد وتثبيت مقيد — بعد مراجعة الجرد

في WSL الخاص بك، مع منع استبدال أي مفتاح موجود:

```bash
test ! -e "$HOME/.ssh/palcert_actions" &&
  ssh-keygen -t ed25519 -N '' -C palcert-actions -f "$HOME/.ssh/palcert_actions"
scp "$HOME/.ssh/palcert_actions.pub" raed@108.165.128.31:palcert_actions.pub
```

انقل سكربتات `scripts/release/automatic` من الالتزام المراجع إلى مجلد تجهيز على الخادم،
ثم نفّذ `sudo bash install-disabled.sh /home/raed/palcert_actions.pub` من هناك.
يثبّت حسابًا بلا صلاحية Docker وforced command وsudo لملف واحد بلا arguments.
يرفض استبدال أي تثبيت سابق. يبقي `/etc/palcert/deploy.json` مع `enabled: false`.
لا يعيد تشغيل SSH أو أي خدمة إنتاج. راجع `AllowUsers` إن كان الخادم يستخدمها؛ لا تفتح
firewall واسعًا لتجاوز مشكلة اتصال، ولا تغيّر حساب المشغّل الحالي.

استخرج مفتاح المضيف **العام فقط** من جلسة الخادم الموثوقة، لا تعتمد `ssh-keyscan`
غير متحقق منه. مثلًا عند تأكيد استخدام المنفذ 22 ومفتاح ED25519:

```bash
sudo awk '{print "108.165.128.31 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

احفظ السطر في ملف `palcert-known-hosts` محليًا وأدخله إلى GitHub مع المفتاح الجديد.
إذا كان GitHub CLI مثبتًا ومخولًا بالحساب الصحيح، بعد إنشاء بيئة production:

```bash
gh secret set PALCERT_DEPLOY_KEY --repo palcertcom/palcert --env production < "$HOME/.ssh/palcert_actions"
gh secret set PALCERT_DEPLOY_KNOWN_HOSTS --repo palcertcom/palcert --env production < palcert-known-hosts
gh variable set PALCERT_DEPLOY_HOST --repo palcertcom/palcert --env production --body 108.165.128.31
gh variable set PALCERT_DEPLOY_PORT --repo palcertcom/palcert --env production --body 22
gh variable set PALCERT_DEPLOY_USER --repo palcertcom/palcert --env production --body palcert-deploy
```

## Adapter المطلوب قبل التفعيل

هذه الملفات **لم تُنشأ بعد** لأنها تعتمد على إعداد الإنتاج غير المتاح من المستودع.
كل hook ملف تنفيذي يملكه root داخل `/usr/local/lib/palcert-deploy/hooks/`؛ يستقبل
مسار request directory وسيطًا واحدًا. يحتوي الدليل manifest وfreeze وstaging record.
stdout/stderr يبقيان في سجل root خاص. مراحل التشغيل بالترتيب:

| الملف | شرط النجاح |
|---|---|
| `preflight` | مطابقة تركيب الإنتاج، نسخ hashes للإعدادات، المساحة، صلاحية الصور، عدم وجود migration فاشلة، توافق التاريخ والشيفرة |
| `pull` | سحب الصور الخمس إلى الخادم بالبصمة، دون بناء أو تغيير خدمات |
| `drain` | منع استقبال أعمال جديدة، انتظار الأعمال والـAI والعمليات المالية، ثم وقف الكتابة بأمان؛ انتهاء المهلة يرفض النشر |
| `backup` | نسخة DB وobjects حديثة ومتسقة بعد drain، فحص checksums والاكتمال، الاحتفاظ بمعرفها ومسارها root-only |
| `rehearse` | استعادة نسخة معزولة من النسخة الفعلية، فحص migrations والتوافق والبيانات والأرصدة؛ عدم طباعة بيانات العملاء أو رفعها إلى GitHub |
| `apply` | تطبيق migrations المسموح بها مرة واحدة ثم الصور الخمس، باستخدام ملفات Compose الثلاثة وشبكاتها؛ لا build ولا down للبيانات |
| `verify` | مطابقة الصور الفعلية والـcommit، readiness وmigration status، حفظ AI/TLS والملفات الأساسية |
| `resume` | فتح استقبال الطلبات بعد النجاح ثم فحص public origin؛ إعادة الإغلاق عند فشل هذا الفحص |

الترقية الأولى: من 81 إلى 84 migration. سكربت `rehearse-database-upgrade.sh` الموجود
مخصص لفحص هذه الترقية ويشترط تطابق قواعد المال القديمة/الجديدة. **لا يصح اعتباره
بوابة عامة لكل ترقية لاحقة** بعد وجود تاريخ revenue sharing. يلزم ضبط سياسة rehearsal
للحالة الفعلية قبل كل نوع migration جديد؛ لا نجعل ذلك الشرط يعيد النجاح تلقائيًا.
تجربة ببيانات اختبار لا تستبدل تجربة نسخة إنتاج حقيقية.

أي فشل ابتداءً من drain يترك `blocked.json` في `/var/lib/palcert-deploy`، ويمنع نشرًا
آخر إلى أن يعالج المشغّل حالة الخدمة والبيانات. لا يوجد rollback تلقائي لقاعدة البيانات
أو للكود المالي؛ قد يكون الرجوع غير آمن حتى بعد إعادة نسبة المؤسسة إلى صفر.
تُحفظ جميع الأدلة، ولا يحذف المتحكم النسخ أو الصور أو volumes أو artifacts.

بوابة SSH تثق بمفتاح النشر المخصص كهوية للـworkflow، وتعيد فحص بيانات GitHub العامة؛
هذا ليس توقيعًا تشفيريًا مستقلًا على manifest. تتطلب وصول الخادم إلى GitHub وGHCR؛
تعذّر GitHub أو حد API يوقف النشر قبل التغيير. تبقى الأسرار ونسخ الإنتاج على الخادم.

## التحقق والتفعيل النهائي

1. مراجعة hooks على التركيب الفعلي وتجربة النجاح والفشل، بما فيها فشل النسخ والاستعادة
   وعدم خلو الطوابير وفشل الصحة وتكرار الطلب وانقطاع اتصال SSH.
2. تحقق أن shell وSCP وport forwarding بالمفتاح المخصص مرفوضة، وطلب النشر مع disabled
   مرفوض دون تغيير خدمات، وبصمة المضيف مثبتة.
3. اختبار pipeline على الصور المنشورة ونسخة الإنتاج المعزولة، ونجاح CI على رأس التغيير النهائي.
4. تثبيت hooks المراجعة وتمكين إعداد الخادم، ثم جعل `PALCERT_AUTO_DEPLOY=true` في
   متغيرات المستودع. بعدها الدمج التالي إلى main يبدأ المسار. لا يكفي تغيير المتغير وحده.
5. إكمال تجربة النشر الأول ومقارنة إيصال الخادم والصور والـcommit والفحص الخارجي.
   حتى ذلك الحين، الوصف الصحيح هو «مجهز وغير مفعّل»، وليس «تم النشر».

## مراجع

- [GitHub: نشر التطبيقات والبيئات والتزامن](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [GitHub: أسرار البيئة وإدخالها من ملف](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub: reusable workflows وصلاحياتها وتزامنها](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- [OpenSSH: authorized_keys وrestrict وcommand](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT)
