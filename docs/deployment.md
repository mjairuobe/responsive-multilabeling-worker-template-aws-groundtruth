# Deployment via GitHub Actions → AWS (OIDC)

Dieser Workflow deployt den Repo-Inhalt ohne statische AWS-Keys, per GitHub
**OIDC**. Trust Policy und OIDC-Provider sind bereits eingerichtet. Es fehlen
nur noch **Permission-Policy**, **S3-Bucket(s)** und die **GitHub-Variablen**.

## 1. Permission-Policy an die Deploy-Rolle hängen

Die Trust Policy regelt nur *wer* die Rolle annehmen darf. Was die Rolle *tun*
darf, kommt über eine Permission-Policy. Minimal für S3-Deployment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeployTemplatesBucket",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::<TEMPLATE_BUCKET>",
        "arn:aws:s3:::<TEMPLATE_BUCKET>/*"
      ]
    },
    {
      "Sid": "DeployPwaBucket",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::<PWA_BUCKET>",
        "arn:aws:s3:::<PWA_BUCKET>/*"
      ]
    }
  ]
}
```

Optional (nur falls CloudFront genutzt wird):

```json
{
  "Sid": "InvalidateCloudFront",
  "Effect": "Allow",
  "Action": "cloudfront:CreateInvalidation",
  "Resource": "arn:aws:cloudfront::423623826655:distribution/<DISTRIBUTION_ID>"
}
```

## 2. S3-Bucket(s) anlegen

Du kannst einen oder zwei Buckets verwenden.

- **Templates-Bucket** (`<TEMPLATE_BUCKET>`): privat. Die Templates werden in
  Ground Truth über `UiTemplateS3Uri` referenziert, z. B.
  `s3://<TEMPLATE_BUCKET>/templates/template.liquid.html`.
- **PWA-Bucket** (`<PWA_BUCKET>`): für die Standalone-App. Entweder über
  CloudFront (empfohlen, HTTPS + privat) oder als statisches S3-Website-Hosting
  ausliefern.

```bash
aws s3 mb s3://<TEMPLATE_BUCKET> --region <REGION>
aws s3 mb s3://<PWA_BUCKET> --region <REGION>
```

> Hinweis: Ein Service Worker (PWA) benötigt **HTTPS**. Reines S3-Website-Hosting
> liefert nur HTTP – für echtes PWA-Verhalten CloudFront davor schalten.

## 3. GitHub-Variablen setzen

**Variables, keine Secrets** – da OIDC genutzt wird, gibt es keine geheimen
Zugangsdaten. Rollen-ARN, Region und Bucket-Namen sind nicht vertraulich.

Repo → **Settings → Secrets and variables → Actions → Tab „Variables“** →
„New repository variable“:

| Variable | Beispiel |
|---|---|
| `AWS_ROLE_ARN` | `arn:aws:iam::423623826655:role/<DEINE_DEPLOY_ROLLE>` |
| `AWS_REGION` | `eu-central-1` |
| `TEMPLATE_BUCKET` | `mein-gt-templates` |
| `PWA_BUCKET` | `mein-annotate-pwa` |
| `CLOUDFRONT_DISTRIBUTION_ID` | *(optional)* `E123ABC...` |

### Brauche ich eine GitHub Environment?

**Nein, standardmäßig nicht.** Der Workflow nutzt **Repository-Variablen** und
läuft auf `main` – das passt zur Trust Policy (`...:ref:refs/heads/main`).

Wichtig: Sobald ein Job `environment: <name>` referenziert, ändert GitHub den
OIDC-`sub`-Claim zu `repo:OWNER/REPO:environment:<name>` (statt `:ref:...`).
Wer eine Environment (z. B. mit *Required reviewers*) nutzen will, muss daher:

1. unter **Settings → Environments** die Environment anlegen (z. B. `prod`),
2. im Workflow `environment: prod` zum Job hinzufügen,
3. **die Trust Policy umstellen** auf:
   ```
   "token.actions.githubusercontent.com:sub": "repo:mjairuobe/responsive-multilabeling-worker-template-aws-groundtruth:environment:prod"
   ```
Variablen können dann optional auch pro Environment definiert werden (überschreiben
gleichnamige Repository-Variablen).

## 4. Deployen

Der Workflow (`.github/workflows/deploy.yml`) läuft automatisch bei jedem Push
auf `main` und kann zusätzlich manuell über **Actions → Deploy to AWS → Run
workflow** gestartet werden.

> Wichtig: Die Trust Policy ist auf `refs/heads/main` eingeschränkt. Deshalb
> erhält der Workflow **nur auf dem `main`-Branch** AWS-Credentials – Läufe auf
> Feature-Branches/PRs bekommen bewusst keine. Den Workflow daher erst nach dem
> Merge nach `main` erwarten.

## 5. Verifizieren

- Actions-Log prüfen: `aws sts get-caller-identity` sollte deine Rolle zeigen.
- Templates im Bucket prüfen und in Ground Truth als `UiTemplateS3Uri`
  hinterlegen.
- PWA-URL (CloudFront/S3) im Browser öffnen.

## 6. Workflow „Clone Labeling Job + UI Preview“

Der Workflow `.github/workflows/clone-labeling-job.yml` ist **manuell**
auslösbar (Actions → *Clone Labeling Job + UI Preview* → *Run workflow*, Branch
`main`). Er:

1. liest einen bestehenden Job aus (`describe-labeling-job`),
2. rendert das Template mit Beispiel-Daten (`render-ui-template`), lädt die
   Vorschau als Artifact hoch **und** erzeugt eine **presigned Test-URL**
   (≈1 Std. gültig) in der Job-Summary,
3. erstellt optional einen **Klon** des Jobs, bei dem nur die `UiTemplateS3Uri`
   auf das deployte Template umgestellt wird (Eingabedaten/Worker/Lambdas wie im
   Original).

### Zusätzliche IAM-Berechtigungen (Pflicht für diesen Workflow)

Die Deploy-Rolle braucht zusätzlich zu den S3-Rechten diese **Identity-Policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GroundTruthCloneAndPreview",
      "Effect": "Allow",
      "Action": [
        "sagemaker:DescribeLabelingJob",
        "sagemaker:CreateLabelingJob",
        "sagemaker:RenderUiTemplate",
        "sagemaker:DescribeWorkteam"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PassExecutionRoleToSageMaker",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::423623826655:role/<SAGEMAKER_EXECUTION_ROLE_VON_EMOJIDYNAMICS>",
      "Condition": { "StringEquals": { "iam:PassedToService": "sagemaker.amazonaws.com" } }
    }
  ]
}
```

Hinweise:
- `<SAGEMAKER_EXECUTION_ROLE_VON_EMOJIDYNAMICS>` ist die `RoleArn` des Quell-Jobs
  (mit `aws sagemaker describe-labeling-job --labeling-job-name EmojiDynamics
  --query RoleArn` herausfinden). `iam:PassRole` ist nötig, weil
  `create-labeling-job` diese Execution-Rolle an SageMaker übergibt.
- Diese **Execution-Rolle** (nicht die Deploy-Rolle) muss ihrerseits
  `s3:GetObject` auf `templatesaws1312161` haben, damit Ground Truth das Template
  lesen kann.
- Greift nur, wenn die **Permissions Boundary** der Rolle diese Aktionen
  ebenfalls zulässt (mit `Allow: *` in der Boundary erfüllt).

### Einschränkung
Der Klon funktioniert am besten, wenn der Quell-Job ein **Custom-Job** ist. Bei
einem Built-in-Tasktyp passen die (AWS-managed) Pre-/Post-Lambdas ggf. nicht zum
Datenformat dieses Templates (`task.input.taskObject` / `labels`).
