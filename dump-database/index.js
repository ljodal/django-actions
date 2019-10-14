const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");

/**
 * Dump the database using pg_dump and check if the output file has changed.
 */
async function dbDumpHasChanged({ outputPath }) {
  // Capture stdout so we can parse it for unapplied migrations.
  const lines = [];

  // List modified or added files, to check if the output file has changed
  await exec.exec("git", ["ls-files", "-mo", outputPath], {
    listeners: {
      stdline: line => lines.push(line)
    }
  });

  // Return true if the dump file has been modified
  return lines.includes(outputPath);
}

async function commitFile({ outputPath, octokit, branch }) {
  // Stash the file, so we can check if it existed before
  await exec.exec("git", ["stash", "--", outputPath]);

  // Check if the file already exists
  const result = await exec.exec("test", ["-f", outputPath], {
    ignoreReturnCode: true
  });

  // If the file existed, get the git object hash
  let sha = undefined;
  if (result === 0) {
    const lines = [];
    await exec.exec("git", ["hash-object", outputPath], {
      listeners: { stdline: line => lines.push(line) }
    });
    sha = lines[0];
  }

  // Restore the modified file
  await exec.exec("git", ["stash", "pop"]);

  // Get the base64 encoded content of the file
  var content = "";
  await exec.exec("base64", ["-i", outputPath], {
    listeners: { stdout: buffer => (content += buffer.toString()) }
  });

  // Create or update the file
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

  try {
    // Apply all migrations
    const appliedMigrations = await applyMigrations();

    // Dump the database to a file
    const hasChanged = await dbDumpHasChanged({ outputPath });

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
