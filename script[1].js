let studentsData = [];

window.onload = () => {
  Papa.parse("students.csv", {
    download: true,
    header: true,
    complete: function(results) {
      studentsData = results.data;
    }
  });

  document.getElementById("admission").addEventListener("blur", autofill);

  document.getElementById("regForm").addEventListener("submit", function(e) {
    e.preventDefault();

    const admission = document.getElementById("admission").value;
    const name = document.getElementById("name").value;
    const studentClass = document.getElementById("class").value;
    const division = document.getElementById("division").value;
    const house = document.getElementById("house").value;
    const category = document.getElementById("category").value;

    const itemElements = document.querySelectorAll('input[name="items"]:checked');
    const items = Array.from(itemElements).map(el => el.value);

    const data = {
      admission,
      name,
      class: studentClass,
      division,
      house,
      category,
      ...Object.fromEntries(items.map((item, i) => [`item${i + 1}`, item]))
    };

    fetch("YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL", {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });

    alert("Submitted successfully!");
    document.getElementById("regForm").reset();
  });
};

function autofill() {
  const admission = document.getElementById("admission").value;
  const student = studentsData.find(s => s["Admission Number"] === admission);

  if (student) {
    document.getElementById("name").value = student["Name"];
    document.getElementById("class").value = student["Class"];
    document.getElementById("division").value = student["Division"];
  } else {
    alert("Admission number not found");
    document.getElementById("name").value = "";
    document.getElementById("class").value = "";
    document.getElementById("division").value = "";
  }
}
