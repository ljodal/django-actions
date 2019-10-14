const path = require("path");
const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");

/**
 * Run "migrate" to make sure the database is up to date.
 */
async function applyMigrations() {
  // Capture stdout so we can optionally include it in the output.
  let stdout = "";
  const options = {
    listeners: {
      stdout: data => {
        stdout += data.toString();
      }
    }
  };

  await exec.exec("python", ["manage.py", "migrate"], options);

  return stdout.trim();
}

/**
 * Dump the database using pg_dump and check if the output file has changed.
 */
async function dumpDatabase({
  dbName,
  dbHost,
  dbPort,
  dbUser,
  dbPass,
  dockerImage,
  outputPath
}) {
  const currentDir = path.normalize(".");

  // Run pg_dump and send the output to the specified path
  await exec.exec("docker", [
    "run",
    "-v",
    `${currentDir}:/github/workspace`,
    "--workdir",
    "/github/workspace",
    "-e",
    `PGPASSWORD=${dbPass}`,
    "--entrypoint",
    "pg_dump",
    dockerImage,
    "-h",
    dbHost,
    "-p",
    dbPort,
    "-d",
    dbName,
    "-U",
    dbUser,
    "--no-owner",
    "-f",
    outputPath
  ]);

  // Capture stdout so we can parse it for unapplied migrations.
  const lines = [];
  const options = {
    listeners: {
      stdline: line => lines.push(line)
    }
  };

  // List modified or added files, to check if the output file has changed
  await exec.exec("git", ["ls-files", "-mo", outputPath], options);

  // Return true if the dump file has been modified
  return lines.includes(outputPath);
}

async function commitFile({ outputPath, octokit, branch }) {
  await exec.exec("git", ["stash", "--", outputPath]);

  const result = await exec.exec("test", ["-f", outputPath], {
    ignoreReturnCode: true
  });

  let sha = undefined;
  if (result === 0) {
    const lines = [];
    await exec.exec("git", ["hash-object", outputPath], {
      listeners: { stdline: line => lines.push(line) }
    });
    sha = lines[0];
  }

  await exec.exec("git", ["stash", "pop"]);

  var content = "";
  await exec.exec("base64", ["-i", outputPath], {
    listeners: { stdout: buffer => (content += buffer.toString()) }
  });

  await octokit.repos.createOrUpdateFile({
    ...github.context.repo,
    path: outputPath,
    message: "Update database template",
    content: content.trim(),
    sha: sha
  });
}

async function makePullRequest({ octokit, branch }) {
  console.log("Creating pull request");

  const pulls = octokit.pulls.list({
    ...github.context.repo,
    state: "open",
    head: `${github.context.repo.owner}:${branch}`
  });

  // The pull request does not already exist, so create it now
  if (pulls.data.length === 0) {
    octokit.pulls.create({
      ...github.context.repo,
      title: "Update database template",
      head: branch,
      base: "master"
    });
  }
}

/**
 * Main entrypoint
 */
async function run() {
  // Initialize the octokit library
  const githubToken = core.getInput("github-token", { required: true });
  const octokit = new github.GitHub(githubToken);

  // Output path to write dumped file to
  const outputPath = core.getInput("output-path", { required: true });

  // Branch to create pr from
  const branch = core.getInput("branch", { required: true });

  // Docker image to run pg_dump in
  const dockerImage = core.getInput("docker-image", { required: true });

  // Get database configuration
  const dbConfig = {
    dbName: core.getInput("db-name", { required: true }),
    dbUser: core.getInput("db-user", { required: true }),
    dbHost: core.getInput("db-host", { required: true }),
    dbPass: core.getInput("db-pass", { required: true }),
    dbPort: core.getInput("db-port", { required: true })
  };

  try {
    // Apply all migrations
    const appliedMigrations = await applyMigrations();

    // Dump the database to a file
    const hasChanged = await dumpDatabase({
      ...dbConfig,
      outputPath,
      dockerImage
    });

    await commitFile({ outputPath, octokit, branch });

    if (hasChanged) {
      await createPullRequest({ octokit, branch });
    }
  } catch (error) {
    console.log("Something went wrong", error);
    core.setFailed(error.message);
  }
}

run();
