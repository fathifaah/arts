function doPost(e) {
  var sheet = SpreadsheetApp.openById("YOUR_SHEET_ID").getSheetByName("Sheet1");
  var data = JSON.parse(e.postData.contents);
  
  var row = [
    data.admission,
    data.name,
    data.class,
    data.division,
    data.house,
    data.category
  ];

  var i = 1;
  while (data["item" + i]) {
    row.push(data["item" + i]);
    i++;
  }

  sheet.appendRow(row);
}
