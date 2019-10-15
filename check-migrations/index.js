const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");

/**
 * Run "makemigrations --dry-run" to check for missing migrations.
 */
async function checkMissingMigrations() {
  // Capture stdout so we can optionally include it in the output.
  let stdout = "";
  const options = {
    listeners: {
      stdout: data => {
        stdout += data.toString();
      }
    },
    ignoreReturnCode: true,
    silent: true
  };

  // Run makemigrations
  const result = await exec.exec(
    "python",
    ["-W", "ignore", "manage.py", "makemigrations", "--dry-run", "--check"],
    options
  );

  return [result !== 0, stdout.trim()];
}

/**
 * Run "showmigrations --plan" to get a list of unapplied migrations.
 */
async function getUnappliedMigrations() {
  // Capture stdout so we can parse it for unapplied migrations.
  let stdout = "";
  const options = {
    listeners: {
      stdout: data => {
        stdout += data.toString();
      }
    },
    ignoreReturnCode: true,
    silent: true
  };

  // Run show
  const result = await exec.exec(
    "python",
    ["-W", "ignore", "manage.py", "showmigrations", "--plan"],
    options
  );

  // Make sure the command exited successfully
  if (result !== 0) {
    throw new Error('Failed to run "showmigrations --plan"');
  }

  // Regex to match output from the management command
  const regex = /^\[(?<applied>[X ])\]\s+(?<appLabel>\w+)\.(?<migrationName>\w+)$/;

  // For each line of the output,
  const unappliedMigrations = stdout
    .trim()
    .split("\n")
    .map(function(line) {
      const match = line.match(regex);

      // We expect all lines to match, so raise an exception if it didn't.
      if (!match) throw new Error(`Line ${line} did not match regex`);

      return match.groups.applied === " "
        ? [match.groups.appLabel, match.groups.migrationName]
        : null;
    })
    .filter(l => l !== null);

  return [unappliedMigrations.length > 0, unappliedMigrations];
}

/**
 * Given an app label and migration name, get the SQL that migration will
 * run and optionally the locks the migraion will take in the database.
 */
async function getMigrationOutput(
  { migrationLocksCommand },
  [appLabel, migrationName]
) {
  // Capture stdout so we can parse it for unapplied migrations.
  let stdout = "";
  const options = {
    listeners: {
      stdout: data => {
        stdout += data.toString();
      }
    },
    ignoreReturnCode: true,
    silent: true
  };

  // Run command to get SQL output.
  let result = await exec.exec(
    "python",
    ["-W", "ignore", "manage.py", "sqlmigrate", appLabel, migrationName],
    options
  );

  // Make sure it exited successfully.
  if (result !== 0) throw new Error("Failed to run sqlmigrate");

  const sql = stdout;
  stdout = "";

  // Run command to get lock details.
  result = await exec.exec(
    "python",
    [
      "-W",
      "ignore",
      "manage.py",
      migrationLocksCommand,
      appLabel,
      migrationName
    ],
    options
  );

  const locks = result === 0 ? stdout : null;

  return { appLabel, migrationName, sql, locks };
}

/**
 * Render a details block.
 */
function renderDetails(title, content) {
  return `<details><summary>${title}</summary>\n\n${content}\n\n</details>`;
}

/**
 * Helper function to render the Markdown for the deatils field of the check.
 */
function renderDetailsMarkdown(
  isMissingMigrations,
  makeMigrationsOutput,
  hasUnappliedMigrations,
  unappliedMigrations
) {
  const unappliedMigrationSummaries = unappliedMigrations.map(function({
    appLabel,
    migrationName,
    sql,
    locks
  }) {
    return [
      `#### ${appLabel}.${migrationName}`,
      renderDetails("SQL", ["```sql", sql, "```"].join("\n")),
      locks ? renderDetails("Locks", ["```", locks, "```"].join("\n")) : ""
    ].join("\n");
  });

  return [
    isMissingMigrations ? "## Missing migrations" : null,
    isMissingMigrations ? "```" : null,
    isMissingMigrations ? makeMigrationsOutput : null,
    isMissingMigrations ? "```" : null,
    hasUnappliedMigrations ? "## New migrations" : null,
    hasUnappliedMigrations ? "" : null,
    hasUnappliedMigrations ? unappliedMigrationSummaries.join("\n") : null
  ]
    .filter(l => l !== null)
    .join("\n");
}

/**
 * Main entrypoint
 */
async function run() {
  // Initialize the octokit library
  const githubToken = core.getInput("github-token", { required: true });
  const octokit = new github.GitHub(githubToken);

  const migrationLocksCommand =
    core.getInput("migrations-lock-command") || "migrationlocks";

  let checkRun;

  try {
    // Initialize a new GitHub check run. We'll update this with a detailed
    // status when we have checked the migrations.
    checkRun = await octokit.checks.create({
      ...github.context.repo,
      name: "Migrations check",
      head_sha: github.context.sha,
      status: "in_progress"
    });

    console.log("Check run", checkRun);
  } catch (error) {
    core.setFailed(error.message);
    return;
  }

  try {
    // Check for missing migrations.
    const [
      isMissingMigrations,
      makeMigrationsOutput
    ] = await checkMissingMigrations();

    // Get a list of unapplied migrations.
    const [
      hasUnappliedMigrations,
      unappliedMigrations
    ] = await getUnappliedMigrations();

    // Get SQL and optionally Postgres locks that a migration will take.
    const unappliedMigrationDetails = await Promise.all(
      unappliedMigrations.map(
        getMigrationOutput.bind(undefined, { migrationLocksCommand })
      )
    );

    // Render markdown for the details section.
    const detailsMarkdown = renderDetailsMarkdown(
      isMissingMigrations,
      makeMigrationsOutput,
      hasUnappliedMigrations,
      unappliedMigrationDetails
    );

    const summary =
      isMissingMigrations && hasUnappliedMigrations
        ? `Missing migrations and ${unappliedMigrations.length} new migrations`
        : isMissingMigrations
        ? "Missing migrations"
        : `${unappliedMigrations.length} new migrations`;

    const updateResult = await octokit.checks.update({
      ...github.context.repo,
      check_run_id: checkRun.data.id,
      completed_at: new Date().toISOString(),
      conclusion: isMissingMigrations ? "failure" : "success",
      output: {
        title: "Migrations check",
        summary: summary,
        text: detailsMarkdown
      }
    });

    console.log("Update result", updateResult);
  } catch (error) {
    console.log("Something went wrong", error);
    core.setFailed(error.message);

    const updateResult = await octokit.checks.update({
      ...github.context.repo,
      check_run_id: checkRun.data.id,
      completed_at: new Date().toISOString(),
      conclusion: "failure",
      output: {
        title: "Migrations check",
        summary: "Failed to check migrations."
      }
    });
  }
}

run();
