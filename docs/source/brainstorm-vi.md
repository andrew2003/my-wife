# My Wife – Tóm tắt brainstorm & đề xuất kỹ thuật (v1)

> Archived source material (Vietnamese). Exported on 2026-11-26 from the brainstorm document. This is the only non-English document in the repository. When it conflicts with `docs/spec/00-final-decisions.md`, file 00 wins. The English domain specs in `docs/spec/` are written from this file during milestone M0.

## Tổng quan

My Wife v1 là một web app kèm bot chat, gồm 2 tính năng lõi: **quản lý chi tiêu** và **quản lý TKB có giám sát**. Đối tượng là bạn trước, sau đó là nhóm bạn bè dưới 100 người. Các tính năng khác (email…) để các version sau, theo nhu cầu hoặc report của người dùng thử.

Nguyên tắc chung:

- **Mọi thông số do người dùng đặt.** Không fix số cho biến nào (số tuần/vòng, số ngân hàng, tỉ lệ, ngưỡng phạt…). Mọi con số trong tài liệu chỉ là ví dụ.
- **Web là nơi xem và chỉnh chính.** Không làm app native, để tránh thủ tục phát hành trên store. Chat (Telegram/Discord; Zalo để sau) dùng để nhắc và hỏi nhanh.
- **Bot không bao giờ tự chuyển tiền.** Bot chỉ đọc biên lai email để xác minh.
- **Phạt dựa trên dữ kiện cứng**, có nhật ký và quyền kháng cáo. Nhãn AI chỉ để tham khảo.
- **Bot học dần như một người vợ.** Hỏi lại khi chưa hiểu, ghi nhớ câu trả lời, và giữ nguyên trí nhớ khi đổi model.
- **Mục tiêu cuối là thói quen.** Giám sát giảm dần đến lúc người dùng "tốt nghiệp".
- **Vận hành:** thử nghiệm trên server của bạn, chạy 24/7. Lên production thì chuyển sang hạ tầng riêng. Mỗi người dùng tự mang API key LLM của mình (BYOK).

## Tính năng 1: Quản lý chi tiêu

Ngân sách chạy theo **vòng x tuần** (người dùng đặt), chia thành các mục nằm trong các ngân hàng riêng. Bot đối chiếu biên lai email với kế hoạch tuần, rồi phạt hoặc chia dư theo luật người dùng đã duyệt.

| Thành phần | Đã chốt |
| --- | --- |
| Mục ngân sách | Không giới hạn số mục, mỗi mục có nhãn Cần / Nên / Muốn / Quỹ. Mục cố định không sinh dư. Các mục đặc biệt: Tiết kiệm (cố định + x% dư), Mua sắm tương lai (y% dư), Phạt, Quỹ dự phòng |
| Vòng ngân sách | x tuần, bỏ qua ngày và tháng. Người dùng nhập ngân sách theo tuần |
| Mở vòng mới | Bot hỏi "có gì mới?" (sửa một phần hoặc toàn bộ cơ chế). Người dùng chuyển tiền vào đúng các ngân hàng, bot xác minh bằng biên lai rồi mới mở vòng. Chưa đủ tiền thì chờ, hoặc người dùng hạ mức |
| Ngân hàng | Không giới hạn, mỗi ngân hàng giữ một nhóm mục để tiền không lẫn |
| Đối chiếu | Biên lai email từ người gửi đã đăng ký. Thứ tự khớp: mã `MW-<tuần>-<mục>-<số>`, rồi mã mục ngắn, rồi người nhận đã học, cuối cùng hỏi người dùng. Lệch ±5% vẫn tính là khớp. Sau 24h chưa rõ thì tính vào Muốn |
| Bất thường | Lương về, bạn trả nợ, QR có nội dung mặc định… bot hỏi lại và học từ câu trả lời |
| Phạt vượt chi | 100% số vượt bị trừ vào hạn mức tuần sau của mục đó và chuyển sang mục Phạt. Người dùng tự chuyển vào tài khoản phạt, bot xác minh. Mục Cần vượt do tăng giá thì chỉ cảnh báo |
| Ngoại lệ | Số lần/vòng do người dùng đặt, lấy từ Quỹ dự phòng |
| Dư cuối vòng | Chia theo x% / y% / phần còn lại, đều do người dùng đặt |
| Sheet | Bot tự tạo một Sheet ngắn cho mỗi vòng theo mẫu đã duyệt. Sheet là bản đồng bộ để xem; web là nơi chỉnh |

**Kế hoạch tuần:** đầu mỗi tuần bot gửi hạn mức từng mục, thực đơn theo ngày và danh sách đồ cần mua (người dùng nhập nguyên liệu thô và món ăn, bot chia theo ngày và ước tính tiền). Mỗi khoản dự kiến có sẵn mã chuyển khoản để đối chiếu.

Web cho phần chi tiêu gồm: trình hướng dẫn mở vòng, danh sách chuyển tiền kèm QR điền sẵn số tiền và nội dung, hộp thư "Bất thường", dashboard vòng, lưu trữ vòng cũ, nhật ký thay đổi, trung tâm kháng cáo và cài đặt.

## Cơ chế xử lý biên lai lạ

Bot không cần mẫu biên lai có sẵn của bất kỳ ngân hàng nào. Gặp mẫu mới, bot đọc bằng LLM, tự đề xuất luật đọc (parser) và tự kiểm chứng. Sau vài lần khớp, mẫu đó được đọc bằng code, không tốn LLM nữa. Thanh toán qua bên thứ 3 (ShopeeFood, Grab…) vẫn là chuyển khoản ngân hàng, nên đi chung đường này.

**Các bước xử lý mỗi email**

1. **Xác thực nguồn:** chỉ nhận email từ người gửi mà người dùng đã khai báo, và phải có chữ ký DKIM hợp lệ của đúng domain ngân hàng. Email giả hoặc tự soạn sẽ bị loại, nên không thể "nộp phạt giả".
2. **Khử trùng:** theo Message-ID và số lệnh giao dịch.
3. **Nhận diện mẫu:** tính dấu vân tay của mẫu (người gửi + dạng tiêu đề + cấu trúc HTML).
   - Mẫu đã tin cậy: parser đọc bằng code.
   - Mẫu mới hoặc parser đọc lỗi: LLM đọc và trả về các trường có cấu trúc, kèm độ tin cậy.
4. **Kiểm chứng kết quả đọc:**
   - Số tiền, số lệnh và thời gian phải xuất hiện nguyên văn trong email, để LLM không thể bịa số.
   - Nếu email có số dư: số dư mới phải bằng số dư cũ trừ đi giao dịch.
   - Sai thì đưa vào hộp thư Bất thường, không tự ghi sổ.
5. **Tự cập nhật cơ chế:**
   - Từ kết quả của LLM, bot sinh một parser dạng dữ liệu (selector/regex) và chạy thử lại trên chính email đó.
   - Lần đầu người dùng xác nhận kết quả. Khớp N lần liên tiếp (N do người dùng đặt) thì mẫu được nâng lên "tin cậy".
   - Ngân hàng đổi mẫu khiến parser lỗi: mẫu bị hạ cấp, quay về đọc bằng LLM và báo cho người dùng. Parser có phiên bản.
6. **Phân loại giao dịch:** các loại trong bảng dưới.
7. **Gán mục:** mã `MW-…`, rồi mã mục ngắn, rồi người nhận hoặc merchant đã học, cuối cùng hỏi người dùng.
8. **Hỏi người dùng:**
   - Nút nhanh: chọn mục, Chuyển nội bộ, Thu nhập, Hoàn tiền, Không phải của tôi.
   - Phạm vi ghi nhớ: chỉ lần này / luôn với người nhận này / luôn với người nhận này và cùng mức tiền.
   - Khoản chi sau 24h chưa rõ thì tính vào Muốn. Khoản thu chưa rõ để ở "Thu chưa phân loại" và không cộng vào ngân sách.

**Các loại giao dịch**

| Loại | Nhận diện | Xử lý |
| --- | --- | --- |
| Chuyển khoản có mã MW | Nội dung có mã | Gán thẳng vào mục. Người dùng không được đổi nhãn |
| Thanh toán bên thứ 3 | Người nhận là ví/cổng thanh toán (ShopeeFood, Grab…) | Học theo người nhận, lần đầu thì hỏi |
| Thẻ quốc tế | Ngoại tệ, tên merchant kiểu `GOOGLE*YouTube` | Quy đổi tạm bằng tỷ giá ngày. Điều chỉnh khi có số VND chính thức (bao gồm phí chuyển đổi). Ghép email "tạm giữ" với email "ghi nợ" để không tính hai lần |
| Đăng ký định kỳ | Cùng merchant, cùng số tiền, lặp theo chu kỳ | Đề xuất chuyển thành mục cố định |
| Chuyển nội bộ | Tiền ra ngân hàng A và tiền vào ngân hàng B của chính người dùng, cùng số tiền, gần nhau về thời gian | Ghép cặp thành Điều chuyển, không tính là chi |
| Nạp vòng / nộp phạt | Tiền vào đúng tài khoản được giao, đúng mã | Tick danh sách chuyển tiền hoặc xoá nợ phạt |
| Thu nhập / bạn trả nợ | Tiền vào không có mã | Bất thường, hỏi lại, học theo người gửi |
| Hoàn tiền | Tiền vào từ merchant đã từng chi | Liên kết với giao dịch gốc và trả lại hạn mức cho mục đó |
| Rút tiền mặt | ATM hoặc rút tại quầy | Bắt buộc phân bổ vào mục trong 24h, nếu không thì tính vào Muốn |
| Thanh toán thẻ tín dụng | Chuyển tiền trả sao kê | Không tính là chi, vì từng giao dịch thẻ đã được tính rồi |
| Phí và lãi ngân hàng | Mẫu phí/lãi | Mục "Phí ngân hàng", tự động |

**Chốt chặn để không lách được**

- **Đối soát số dư:** mỗi tuần, người dùng nhập số dư thực của từng ngân hàng (hoặc bot lấy từ email có số dư). Chênh lệch giữa số dư dự kiến và thực tế là khoản chi bị thiếu biên lai, được đưa vào Bất thường. Bước này bắt được cả email bị xoá hay giao dịch không gửi email.
- **Ngân hàng phải bật thông báo email:** ngân hàng không gửi email biên lai thì không được giao giữ mục.
- **Chuyển ra tài khoản không khai báo:** nếu là tài khoản của chính người dùng thì phải khai báo tài khoản đó, nếu không thì tính là chi.
- **Không sửa sổ đã chốt:** đổi nhãn sau khi tuần đã chốt phải qua kháng cáo và được ghi nhật ký. "Không phải của tôi" có hạn mức số lần.
- **LLM chỉ đề xuất:** ghi sổ, tính phạt và chia dư đều do code chạy trên dữ liệu đã qua bước kiểm chứng.

**Cách nhận email (đề xuất đổi):** dùng **chuyển tiếp thư** thay vì đăng nhập Gmail bằng OAuth. Mỗi người dùng có một địa chỉ nhận riêng (ví dụ `u-abc123@in.mywife.…`). Họ tạo bộ lọc trong Gmail để tự chuyển tiếp thư của ngân hàng tới địa chỉ đó. Lý do:

- Bot chỉ thấy thư ngân hàng, không đụng được toàn bộ hộp thư.
- Không vướng quy định xác minh app của Google. Nếu dùng OAuth ở chế độ Testing, quyền của test user và refresh token hết hạn sau 7 ngày ([Google](https://support.google.com/cloud/answer/15549945)). Muốn bỏ giới hạn thì phải qua xác minh, và scope gmail.readonly còn cần thêm đánh giá bảo mật ([Nylas](https://developer.nylas.com/docs/cookbook/use-cases/build/fix-google-access-denied/)).
- Chữ ký DKIM gốc của ngân hàng thường vẫn còn sau khi chuyển tiếp, nên bước 1 vẫn xác thực được. Cần test với từng ngân hàng thật.

**Nợ, chi chung nhóm và thu nhập**

Ba loại tiền này không phải chi tiêu thật, nên được ghi vào **sổ nợ** hoặc **quỹ thu**, không trừ vào mục. Luật khóa: khoản phải thu quá hạn mà không được trả sẽ tự chuyển thành chi tiêu, để không ai dùng "chi chung" hay "cho vay" để né vượt chi.

| Tình huống | Bot nhận ra thế nào | Ghi sổ ra sao | Khi không được giải quyết |
| --- | --- | --- | --- |
| **Cho bạn vay** | Tiền ra, người dùng bấm "Cho vay" | Mở khoản phải thu (người, số tiền, hạn trả tuỳ chọn). Tiền tạm lấy từ mục người dùng chọn, thường là Quỹ dự phòng | Quá hạn thì nhắc người dùng. Quá hạn + X ngày thì hỏi: vẫn chờ hay xoá nợ (xoá nợ = chi của mục đó) |
| **Bạn trả nợ** | Tiền vào khớp tên người gửi và số tiền còn nợ (cho phép trả nhiều lần) | Giảm khoản phải thu, hoàn lại hạn mức cho mục đã ứng | Không khớp khoản nào thì đưa vào Bất thường |
| **Mình đi vay** | Tiền vào, người dùng bấm "Đi vay" | Mở khoản phải trả, không tính là thu nhập. Tiền vay tiêu vẫn trừ vào mục như thường | Đến hạn thì tự tạo task "Trả nợ" trong checklist |
| **Mình trả nợ** | Tiền ra khớp khoản phải trả | Đóng khoản, không tính là chi | – |
| **Mình trả hộ cả nhóm** | Người dùng bấm "Chi chung", nhập số người hoặc phần của mình | Phần của mình tính vào mục. Phần còn lại thành khoản phải thu từ từng người | Sau X ngày (người dùng đặt) chưa thu đủ thì phần thiếu tự tính vào mục, có thể gây vượt chi và bị phạt |
| **Bạn trả hộ mình** | Mình chuyển lại phần của mình | Chi tiêu bình thường của mục, nên ghi mã `MW-…` để khớp ngay | Không mã thì hỏi như mọi khoản khác |
| **Thu nhập** (lương, thưởng, freelance) | Tiền vào từ người trả đã học (công ty, khách). Lần đầu thì hỏi | Vào **quỹ thu**, không cộng vào ngân sách vòng đang chạy | – |

**Thu nhập nối với vòng mới:** khi mở vòng, trình hướng dẫn hiện tổng quỹ thu từ vòng trước. Nó gợi ý ngân sách (giữ như cũ, hoặc theo tỉ lệ thu nhập do người dùng đặt) và bảng chuyển tiền vào từng ngân hàng. Người dùng duyệt rồi chuyển tiền. Phần thu nhập không dùng cho vòng mới được gợi ý đưa vào Tiết kiệm hoặc Mua sắm tương lai. Lương về trễ thì vòng chờ, như đã chốt.

**Sổ nợ trên web:** mỗi người một dòng (mình nợ / nợ mình / hạn / lịch sử). Bot chỉ nhắc người dùng, không bao giờ tự nhắn tin đòi nợ bạn của họ.

## Tính năng 2: Quản lý TKB có giám sát

Mỗi tuần có một TKB chia theo ngày, mỗi task có sub-task và đồng hồ đếm ngược. Trong khung giờ làm việc người dùng tự đặt, họ bắt buộc phải mở web và bật cam. Lỗi cứng được tích điểm, chạm mốc thì phạt tiền vào mục Phạt.

**Lập kế hoạch**

- **TKB tuần:** cuối tuần bot hỏi để cập nhật tuần sau, dựa trên review tuần (task hay trễ, ước tính lệch, khung giờ làm hiệu quả nhất) để gợi ý sắp xếp.
- **Task:** sub-task, thời lượng do người dùng đặt, pomodoro tuỳ chỉnh, "định nghĩa xong", mức năng lượng cần, hồ sơ giám sát riêng cho từng task.
- **Mẫu và lặp lại:** mẫu ngày/tuần, task lặp theo lịch dương và âm (giỗ, rằm, mùng 1).
- **Luật dồn việc:** task chưa xong thì dồn sang hôm sau, hạ ưu tiên hoặc hỏi lại, do người dùng chọn.
- **Nhịp ngày:** sáng chọn top 3 việc, tối dành 2 phút nhìn lại.
- **Chế độ ốm/du lịch/lễ:** tạm dừng giám sát và phạt, có hạn mức số ngày mỗi vòng.
- **Việc tiền bạc tự vào checklist:** "Chuyển tiền vòng mới" và "Nộp phạt".
- **Tab lịch:** hiện cả âm lịch và dương lịch, đồng bộ TKB lên Google Calendar.

**Khi làm việc**

- **Checklist ngày:** người dùng tự tick. Bot không gửi tin "đã xong task".
- **Đếm ngược từng giây:** con số tính theo đồng hồ thật, nhịp tick chạy trong Web Worker. Camera bật liên tục giúp tab không bị bóp xuống 1 lần/phút. Âm thanh hết giờ được hẹn bằng Web Audio. Có cửa sổ nổi PiP (Chrome/Edge). Server push làm dự phòng khi tab chết.
- **Giám sát real-time ngay trên máy:** MediaPipe chạy trong trình duyệt, khoảng 2–5 khung hình/giây. Video không rời máy, chi phí cloud gần như bằng 0. Chỉ gửi một khung hình lên AI vision khi người dùng kháng cáo hoặc kết quả mơ hồ.
- **Nút "Tạm nghỉ":** bấm trước khi đi vệ sinh, uống nước… thì không bị tính lỗi.

**Loại tín hiệu**

| Loại | Ví dụ | Hệ quả |
| --- | --- | --- |
| Cứng | Mất heartbeat (đóng web, ngủ máy), tắt hoặc che camera, không thấy mặt quá N giây, rời tab quá lâu | Tin khẩn, có thể cộng điểm lỗi |
| Mềm | Nhìn lệch, cúi đầu, ngáp, dấu hiệu buồn ngủ | Chỉ nhắc và gán nhãn, không phạt |

**Tin khẩn và tích luỹ phạt**

- **Leo thang:** banner trên web kèm nút lý do nhanh, sau N giây không trả lời thì gửi tin chat, vẫn im lặng thì ghi lỗi không lý do.
- **Lý do:** mỗi loại có hạn mức riêng. Thành thật thì tính nhẹ hơn im lặng. Có 24h để bổ sung lý do hoặc kháng cáo.
- **Sổ lỗi:** điểm có trọng số, mốc phạt theo tuần hoặc vòng, vài thẻ miễn mỗi tuần, tuần sạch lỗi thì được xoá điểm hoặc thưởng.
- **Nộp phạt:** tiền vào mục Phạt, web tạo QR điền sẵn, bot xác minh bằng biên lai.
- **Giới hạn tin:** tối đa 1 tin khẩn mỗi 5 phút, không gửi trong giờ nghỉ. Mọi tin đều được gom vào một hộp thư trên web.

**Chế độ thử với phạt treo** (áp dụng cho cả phạt vượt chi và phạt giám sát)

1. **Trong thời gian thử** (N tuần, người dùng đặt): hệ thống tính điểm lỗi, mốc phạt và tiền phạt như thật, nhưng ghi vào **sổ phạt treo** và chưa bắt nộp. Báo cáo tuần ghi rõ "phạt treo đến nay: X đồng".
2. **Luật khóa theo thời điểm:** mỗi lỗi tính theo luật đang áp dụng lúc xảy ra. Người dùng vẫn chỉnh luật được trong thời gian thử, nhưng luật mới chỉ áp cho lỗi sau đó, không giảm hồi tố các lỗi đã ghi.
3. **Miễn tự động:** lỗi nằm trong khoảng server sập, bot đọc sai đã được xác nhận, hoặc kháng cáo thành công đều được xoá khỏi sổ treo. Mục đích của thời gian thử là lọc lỗi của hệ thống, không phải xóa lỗi của người dùng.
4. **Kết thúc thử:** bot gửi bản tổng kết từng lỗi, kèm hạn kháng cáo cuối (ví dụ 72h). Hết hạn thì tổng phạt treo thành một khoản phạt thật trong mục Phạt.
5. **Nộp:** trả một lần, hoặc chia đều vào K tuần tới (K do người dùng chọn khi bật chế độ thử, không đổi được lúc kết thúc). Mỗi đợt vẫn nộp bằng QR và được xác minh bằng biên lai. Không nộp đúng hạn thì xử như nợ phạt thông thường.
6. **Không thoát được:** tắt chế độ thử giữa chừng hay xoá tài khoản không xoá phạt treo. Tắt giữa chừng = kết thúc thử ngay.

**Nhịp sinh hoạt (ngoài giờ làm việc)**

Ăn, ngủ, nghỉ được quản lý bằng một lớp riêng gọi là **nhịp sinh hoạt**, tách khỏi task làm việc. Mặc định lớp này không dùng camera và không phạt. Mỗi người tự chọn quản lý những thói quen nào và ở mức nào. Thói quen không bật thì không xuất hiện trong TKB.

| Mức | Bot làm gì | Phạt |
| --- | --- | --- |
| Tắt | Không quản lý | Không |
| Chỉ nhắc | Gửi tin đúng giờ | Không |
| Nhắc + ghi nhận | Nhắc và xin check-in ("đã ăn", "đã dậy"), ghi lại để review tuần | Không |
| Cam kết | Nhắc, check-in có hạn, leo thang nếu trễ | Có, theo luật và ngưỡng người dùng đặt. Chỉ dựa trên giờ check-in (dữ kiện cứng) |

**Hai loại khối giờ**

- **Khối cố định:** giờ được giữ chặt, ví dụ ngủ 23:00–6:30.
- **Khối linh hoạt:** có khung giờ và thời lượng, ví dụ ăn trưa 30 phút trong khoảng 11:30–13:30. Bot tự đặt khối này vào khoảng trống giữa các task.
- **Hồ sơ theo ngày:** ngày thường và cuối tuần có giờ khác nhau. Chế độ ốm/du lịch tự nới lỏng.

**Luật với TKB làm việc**

- **Giữ chỗ trước:** khi lập TKB tuần, nhịp sinh hoạt được xếp vào trước, task làm việc xếp vào phần thời gian còn lại. Không đủ chỗ thì báo "tuần này quá tải" ngay lúc lập kế hoạch, không để đến lúc trễ.
- **Không làm việc vào giờ ngủ:** muốn xếp task vào giờ ngủ phải xác nhận riêng, và việc này được đếm trong review tuần.
- **Nghỉ là hợp lệ:** nghỉ pomodoro, bữa ăn và nghỉ dài tự tạm dừng giám sát, không tính lỗi. Làm liên tục quá X giờ (người dùng đặt) thì bot đề nghị nghỉ.
- **Làm lấn vào giờ ăn:** phiên làm việc kéo qua khung bữa ăn thì nhắc nghỉ ăn. Bỏ bữa nhiều lần được ghi vào review tuần, không phạt. Nếu đã có thực đơn trong phần chi tiêu, tin nhắc ghi luôn món hôm nay.

**Luồng ngủ và dậy** (giờ đều do người dùng đặt)

1. **Trước giờ ngủ 60 phút:** nhắc "chuẩn bị kết thúc ngày": chốt checklist, xem việc ngày mai.
2. **Trước 15 phút:** nhắc đi ngủ. Nếu đang có phiên làm việc, web hiện đếm ngược kết thúc phiên.
3. **Đúng giờ ngủ:** web chuyển sang màn hình "đến giờ ngủ" và dừng giám sát. Bắt đầu giờ yên lặng: không gửi tin không khẩn.
4. **Vẫn còn hoạt động trên web sau giờ ngủ:** nhắc lại một lần, ghi nhãn "thức khuya" (nhãn mềm). Có nút lý do nhanh: việc gấp, không ngủ được…
5. **Giờ dậy:** gửi tin dậy kèm nút "Tôi đã dậy". Chưa check-in thì gửi lại mỗi 5 phút, tối đa N lần, giọng thúc giục tăng dần.
6. **Hết thời gian ân hạn:** ghi "dậy trễ X phút". Ở mức Cam kết thì tính điểm lỗi.

**Chứng minh đã dậy bằng ảnh trong chat**

1. **Thử thách ngẫu nhiên:** đúng giờ dậy, bot gửi tin kèm một yêu cầu đổi mỗi ngày, ví dụ giơ N ngón tay, chụp ở bồn rửa mặt, cầm một đồ vật. Bot không có cách chắc chắn để biết ảnh vừa chụp hay lấy từ thư viện, nên thử thách làm ảnh cũ vô dụng.
2. **Chụp và gửi:** người dùng mở camera ngay trong Telegram/Discord, chụp và gửi trong hạn (số phút do người dùng đặt).
3. **AI chấm ảnh:** model đọc ảnh của người dùng kiểm tra có mặt người, mắt mở, đã rời giường và đúng thử thách. Kết quả là Đạt, Chưa đạt hoặc Không rõ. Không rõ thì xin ảnh khác, không tính trượt.
4. **Ghi nhận hai bên:** giờ dậy = giờ gửi tấm ảnh đạt. Bot trả lời xác nhận, ví dụ "Ghi nhận dậy lúc 6:02, đúng cam kết" hoặc "trễ 14 phút". Ở mức Cam kết, trễ quá thời gian ân hạn thì tính điểm lỗi, có quyền kháng cáo.
5. **Chống ngủ lại** (tuỳ chọn): check-in lần hai sau 15–20 phút bằng nút bấm hoặc mở web.
6. **Quyền riêng tư:** khác với giám sát lúc làm việc, ảnh này đi qua Telegram/Discord và nhà cung cấp LLM. Cần xin đồng ý riêng. Server chỉ lưu kết quả và xoá ảnh sau khi chấm; ảnh Chưa đạt được giữ đến hết hạn kháng cáo.
7. **Model không đọc được ảnh:** người dùng chọn riêng một model có đọc ảnh trong Cài đặt. Không có thì hạ về bấm nút kèm câu hỏi nhanh.

Cơ chế ảnh trong chat này dùng lại được cho các check-in khác: task ngoài máy tính, đã ăn, đã tập.

**Giới hạn cần biết:** điện thoại ở chế độ Không làm phiền hoặc tắt tiếng Telegram/Discord thì tin dậy không kêu. Nên người dùng vẫn đặt báo thức trên điện thoại. Bot phụ trách phần sau báo thức: thúc, xác nhận đã dậy và ghi sổ. Lúc cài đặt có bước hướng dẫn cho phép bot kêu trong giờ Không làm phiền.

**Học và giảm dần:** review tuần hiển thị giờ ngủ ước tính (từ hoạt động cuối trên web), giờ dậy theo check-in, số bữa bỏ, và so với hiệu suất làm việc để gợi ý chỉnh giờ. Thói quen đều đặn liên tục X ngày thì bot tự giảm nhắc, chỉ giữ check-in dậy.

**Giám sát giảm dần:** đầy đủ, rồi bỏ camera, rồi chỉ checklist, rồi "tốt nghiệp".

**Quyền riêng tư:** dữ liệu khuôn mặt là dữ liệu nhạy cảm theo luật bảo vệ dữ liệu cá nhân Việt Nam (hiệu lực từ 01/01/2026). Cần xin đồng ý riêng cho từng mục đích, và không lưu ảnh. Mình không phải luật sư.

## Khởi tạo: mẫu chuẩn và hướng dẫn người mới

Người mới không phải tự dựng từ trang trắng. Bot hỏi vài câu, sinh ra **TKB mẫu** và **ngân sách mẫu**, người dùng sửa rồi duyệt. Ai không muốn trả lời thì nhận mẫu chuẩn mặc định và chỉnh sau.

**Lần đăng nhập đầu tiên**

1. **Tour hướng dẫn** từng màn hình (TKB, chi tiêu, hộp thư, cài đặt). Có nút **Bỏ qua** ở mọi bước, và mở lại được trong Cài đặt.
2. **Chế độ xem thử:** một tài khoản mẫu có sẵn dữ liệu giả để bấm thử mọi thứ trước khi cấu hình thật.
3. **Danh sách thiết lập**, mỗi bước có nút kiểm tra thật:
   - Kết nối Telegram hoặc Discord: bot gửi tin thử.
   - Nhập API key LLM: bot gọi thử một câu.
   - Tạo bộ lọc chuyển tiếp thư ngân hàng: chờ nhận được thư thử.
   - Cho phép thông báo và camera, cài web ra Màn hình chính.
4. **Hỏi đáp tạo mẫu** (bỏ qua được từng câu).
5. **Duyệt và ký bản cam kết** (xem phần Bổ sung sau rà soát), bắt đầu chế độ thử.

**Bot hỏi gì để tạo mẫu**

| Mẫu | Câu hỏi đầu vào | Không trả lời thì |
| --- | --- | --- |
| TKB | Giờ làm/học cố định, giờ dậy mong muốn, số giờ ngủ, các bữa ăn, việc lặp lại (tập, học thêm…), khung giờ tập trung tốt nhất | Dùng mẫu ngày chuẩn bên dưới |
| Ngân sách | Tổng ngân sách hoặc thu nhập mỗi vòng, số tuần/vòng, các khoản cố định (thuê nhà, hoá đơn), mục tiêu tiết kiệm, các ngân hàng đang dùng | Dùng bộ mục chuẩn (như tab Mục ngân sách trong Sheet brainstorm), chia theo tỉ lệ mẫu |

Có sẵn vài bộ mẫu theo kiểu người dùng: sinh viên, người đi làm giờ hành chính, freelancer thu nhập không đều. Mức quản lý nhịp sinh hoạt trong mẫu chuẩn: ngủ và ăn ở "Nhắc + ghi nhận", dậy sớm do người dùng tự bật "Cam kết".

**Mẫu ngày chuẩn** (ví dụ, mọi giờ đều sửa được)

| Giờ | Khối | Loại |
| --- | --- | --- |
| 06:00 | Dậy, gửi ảnh check-in | Sinh hoạt |
| 06:00–07:30 | Vệ sinh, vận động, ăn sáng | Sinh hoạt |
| 07:30–07:45 | Chọn top 3 việc trong ngày | Nhịp ngày |
| 08:00–12:00 | Làm việc sâu, chia phiên pomodoro | Làm việc, có giám sát |
| 12:00–13:30 | Ăn trưa, nghỉ | Sinh hoạt (linh hoạt) |
| 13:30–17:30 | Làm việc | Làm việc, có giám sát |
| 17:30–19:30 | Vận động, ăn tối | Sinh hoạt (linh hoạt) |
| 19:30–21:30 | Học hoặc dự án cá nhân | Làm việc, tuỳ chọn giám sát |
| 21:30–22:00 | Nhìn lại ngày, chốt checklist | Nhịp ngày |
| 23:00 | Ngủ | Sinh hoạt (cố định) |

Sau 1–2 tuần dùng thật, review tuần đề xuất chỉnh mẫu theo dữ liệu thực tế của từng người.

## AI "một người vợ duy nhất" khi đổi model

Mỗi người dùng tự mang API key và chọn platform/model (Claude, GPT, DeepSeek, Gemini…). Model chỉ là "bộ não để suy nghĩ". Toàn bộ trí nhớ và tính cách nằm trong database của My Wife, không nằm trong model. Vì vậy đổi model không làm sinh ra một "người vợ mới".

Bốn lớp đảm bảo tính liên tục:

1. **Hồ sơ nhân vật (persona):** giọng nói, cách xưng hô, quy tắc cư xử. Người dùng chỉnh được, có phiên bản, và được nạp vào mọi lần gọi model.
2. **Trí nhớ có cấu trúc:** dữ kiện bot đã học, ghi thành bản ghi có nguồn và ngày, ví dụ "người nhận X là mục Ăn ngoài", "thứ 2 hay trễ task code buổi chiều". Người dùng xem, sửa, xoá được trên web.
3. **Lịch sử và tóm tắt:** hội thoại gần giữ nguyên, hội thoại cũ được tóm tắt định kỳ. Tìm lại theo ngữ nghĩa bằng vector (pgvector).
4. **Tool và luật chung:** mọi model gọi cùng một bộ tool (ghi giao dịch, tạo task, hỏi lý do…). Luật tiền và phạt do code quyết định, không phải LLM, nên đổi model không đổi kết quả.

Khi đổi model:

- **Bài kiểm tra bàn giao:** chạy một bộ câu hỏi cố định ("ngân sách ăn uống tuần này còn bao nhiêu?", "tôi hay trễ task gì?") và so với model cũ. Model mới phải trả lời đúng và đúng giọng mới được bật.
- **Dự phòng (fallback):** mỗi người dùng có model chính và model phụ. Key lỗi hoặc hết hạn mức thì chuyển sang model phụ mà vẫn giữ cùng trí nhớ.
- **Phân vai model:** có thể dùng model rẻ cho việc nhỏ (phân loại email, đọc biên lai) và model mạnh cho chat và review tuần. Việc này do người dùng cấu hình.
- **Không lộ key:** key được mã hoá khi lưu, chỉ server giải mã lúc gọi, không bao giờ gửi xuống trình duyệt. Web có trang theo dõi số token đã dùng theo từng người.

## Kiến trúc và tech stack

Kiến trúc: **microservice, cả FE và BE đều là TypeScript**, nằm chung một monorepo và chạy bằng Docker Compose trên server của bạn. Mỗi service giữ một miền nghiệp vụ. Real-time (đồng hồ, camera) vẫn chạy trong trình duyệt để server nhẹ.

&#91;embedded content: kiến trúc My Wife v1 · 3 lớp\]

Gateway là cửa duy nhất ra ngoài. Các service hỏi nhau qua REST nội bộ và báo tin qua event bus. Ví dụ Biên lai phát sự kiện `receipt.parsed`, Chi tiêu ghi sổ, Luật & phạt tính phạt, Thông báo gửi tin. Nhờ vậy mỗi service vibe code độc lập được, chỉ cần giữ đúng hợp đồng.

| Service | Giữ dữ liệu | Phát / nhận sự kiện chính |
| --- | --- | --- |
| gateway | phiên đăng nhập | – |
| identity | users, settings, consents, llm\_keys | user.updated |
| budget (Chi tiêu) | vòng, mục, ngân hàng, sổ giao dịch | nhận receipt.parsed; phát txn.recorded, cycle.opened, overspend.detected |
| ingest (Biên lai) | email thô, receipt\_templates | phát receipt.parsed, receipt.unknown |
| schedule (TKB) | tuần, task, session, template | phát task.started, task.ended, week.closed |
| monitor (Giám sát) | heartbeat, focus\_events, reasons | phát fault.detected, reason.given |
| rules (Luật & phạt) | fault\_points, penalties, appeals | nhận fault.*, overspend.*; phát penalty.issued |
| ai | persona, memories, conversations | nhận mọi sự kiện cần hỏi đáp; gọi tool của các service khác |
| notify (Thông báo) | hộp thư, lịch gửi | nhận mọi \*.ask, penalty.issued; gửi Telegram, Discord, web push |
| sync (Đồng bộ) | liên kết Sheet/Calendar | nhận txn.*, task.*; đẩy sang Google |

| Lớp | Đề xuất | Vì sao |
| --- | --- | --- |
| Monorepo | pnpm workspaces + Turborepo | FE và 10 service nằm chung một repo, một lệnh build/test. Claude Code thấy đủ ngữ cảnh |
| Hợp đồng chung | Package `contracts`: schema zod và kiểu TS cho mọi API và sự kiện | FE và BE dùng chung một định nghĩa, để các session vibe coding không lệch nhau |
| FE | Next.js (React + TS), PWA, Tailwind + shadcn/ui | Một codebase cho máy tính và điện thoại. Claude viết bộ này rất quen |
| Real-time trên máy | @mediapipe/tasks-vision, worker-timers, Web Audio, Document PiP | Đếm giây và giám sát không tốn tiền cloud |
| Service | Node.js + TS, Fastify, mỗi service một container | Nhẹ, nhanh, ít boilerplate hơn NestJS |
| Giao tiếp | REST nội bộ cho truy vấn, NATS JetStream cho sự kiện | Sự kiện được lưu và phát lại, service chết dậy vẫn nhận đủ |
| Real-time server | WebSocket trong monitor service | Heartbeat và tin khẩn |
| Hẹn giờ | BullMQ + Redis | Nhắc giờ, mở vòng, hết hạn 24h |
| Database | Một PostgreSQL, mỗi service một schema riêng, pgvector; ORM Drizzle | Tách dữ liệu như microservice thật nhưng chỉ vận hành một DB |
| LLM | Vercel AI SDK | Một giao diện cho nhiều provider, có tool calling |
| Email đến | Máy chủ nhận thư (ví dụ Haraka hoặc Cloudflare Email Routing đẩy vào webhook), mailauth để kiểm DKIM | Nhận thư chuyển tiếp, không cần OAuth Gmail |
| Chat | grammY (Telegram), discord.js | Hai kênh cho bản demo, Zalo để sau |
| Google | Sheets API, Calendar API (OAuth, scope không thuộc nhóm hạn chế như Gmail) | Sheet mỗi vòng, đồng bộ TKB |
| Âm lịch, QR | Thư viện âm lịch (thuật toán Hồ Ngọc Đức); link img.vietqr.io hoặc qr.sepay.vn | Rằm, giỗ; QR điền sẵn tiền và nội dung |
| Triển khai | Docker Compose, Cloudflare Tunnel (HTTPS, không mở cổng), Caddy làm reverse proxy nội bộ, GitHub Actions, backup DB hằng ngày | Camera và push chỉ chạy trên HTTPS |
| Theo dõi | Log JSON (pino) có trace id xuyên service, xem bằng Grafana Loki | Microservice mà không có trace id thì rất khó debug |

## Hạ tầng: tên miền, HTTPS, nhận thư

Bạn chỉ cần mua **một tên miền**. Phần còn lại dùng gói miễn phí của Cloudflare, và dùng chung được cho mọi dự án sau bằng tên miền phụ (`mywife.…`, `duan2.…`).

| Nhu cầu | Giải pháp | Chi phí |
| --- | --- | --- |
| Tên miền | [Cloudflare Registrar](https://developers.cloudflare.com/registrar): bán đúng giá gốc của nhà quản lý tên miền, gia hạn không tăng giá. Nên chọn đuôi `.com` hoặc `.dev`, tên trung tính (tên bạn hoặc tên studio) để dùng cho nhiều dự án | Phí năm theo giá gốc của đuôi |
| DNS | Cloudflare DNS (đi kèm khi mua ở Cloudflare) | Miễn phí |
| HTTPS + đưa server ra internet | [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel): cài `cloudflared` trên server, không cần IP tĩnh, không mở cổng router, tự có chứng chỉ HTTPS. Mỗi dự án một tên miền phụ trỏ vào một cổng nội bộ | Miễn phí |
| Bản ghi MX + nhận thư | [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) tự thêm MX và SPF. Email Worker nhận thư gửi tới `*@in.<tên-miền>` và đẩy bản thô về webhook của ingest service qua Tunnel | Miễn phí ở mức cá nhân |
| Thư cá nhân (`ban@<tên-miền>`) | Cũng Email Routing, chuyển về Gmail của bạn | Miễn phí |

Lưu ý:

- **Xác nhận chuyển tiếp của Gmail:** khi người dùng thêm địa chỉ chuyển tiếp, Gmail gửi một thư xác nhận tới địa chỉ đó. Ingest service phải bắt thư này và hiện mã xác nhận ngay trên web.
- **Server ở nhà:** Tunnel giúp chạy được cả khi nhà mạng không cho IP công khai. Nhưng mất điện, mất mạng là mất giám sát, nên cần luật miễn lỗi khi server sập. Khi lên production thì chuyển sang VPS, tên miền giữ nguyên.
- **Đuôi `.vn`:** phải mua qua nhà đăng ký trong nước và khai thông tin chủ thể. Cloudflare không bán đuôi này, nên chỉ nên chọn khi cần thương hiệu Việt.

Thứ tự thiết lập: tạo tài khoản Cloudflare (bật 2FA) → mua tên miền → cài `cloudflared` trên server và tạo tunnel → bật Email Routing → tạo Email Worker khi bắt đầu code.

## Quy trình GitHub

Toàn bộ code nằm trong **một repo private trên GitHub**, làm việc qua Pull Request và CI bắt buộc. Mỗi session vibe coding (ở bất kỳ đâu) là một nhánh và một PR, nên code từ nhiều nơi vẫn về cùng một chỗ, có kiểm tra.

**Tổ chức**

- Tạo một **GitHub Organization** (miễn phí) cho các dự án của bạn, repo `my-wife` nằm trong đó. Dự án sau dùng chung org, secret và runner.
- Cấu trúc repo: `apps/web`, `services/<tên>`, `packages/contracts`, `packages/config` (eslint, tsconfig), `infra/` (compose, tunnel), `docs/` (spec, ADR ghi quyết định), `.github/`.
- `CLAUDE.md` ở gốc và trong từng service, để mọi session Claude đọc cùng một luật.

**Luật nhánh và commit**

- `main` được bảo vệ bằng ruleset: bắt buộc qua PR, CI phải xanh, chỉ squash merge, cấm force push.
- Nhánh theo loại việc: `feat/…`, `fix/…`, `chore/…`. Commit theo Conventional Commits.
- release-please tự sinh phiên bản và CHANGELOG từ commit.
- Mẫu PR (mô tả, cách test, ảnh chụp nếu đổi giao diện), mẫu issue (bug, tính năng), bộ nhãn theo service.
- GitHub Projects làm bảng công việc, milestone P0–P4 khớp với lộ trình. Report lỗi từ web tự tạo issue.

**CI/CD (GitHub Actions)**

1. Mỗi PR: lint, typecheck, unit test, kiểm tra contracts, build. Turborepo chỉ chạy phần bị ảnh hưởng.
2. Merge vào `main`: build image Docker cho từng service và đẩy lên GitHub Container Registry.
3. Deploy: một self-hosted runner trên server kéo image mới về và chạy lại Compose. Không cần mở cổng SSH ra ngoài, hợp với Tunnel.
4. Hai môi trường `staging` và `production`, mỗi môi trường có secret riêng. Production cần bạn bấm duyệt.

**Bảo mật repo**

- Bật secret scanning + push protection, Dependabot, CodeQL. Bật 2FA cho tài khoản.
- Không commit `.env`. Secret nằm trong GitHub Environments và trên server.
- Email thật dùng làm fixture phải ẩn số tài khoản và tên trước khi commit.

Chưa tạo repo hay viết code nào cho đến khi bạn yêu cầu.

## Dữ liệu, cơ chế code và lộ trình

Nguyên tắc thiết kế quan trọng nhất: **luật tiền, điểm lỗi và phạt do code quyết định.** LLM chỉ hiểu ngôn ngữ, trò chuyện và gợi ý. Nhờ vậy kết quả luôn kiểm tra được và không đổi khi đổi model.

**Các bảng dữ liệu chính** (mọi bảng đều có `user_id`)

| Nhóm | Bảng |
| --- | --- |
| Tài khoản | users, settings (kênh, giờ yên lặng, khung giám sát), llm\_keys (mã hoá), consents |
| Chi tiêu | cycles, budget\_items, banks, weekly\_plans, transactions, receipts, receipt\_templates (parser đã học, có phiên bản), reconciliations, learned\_payees, merchant\_rules, balance\_snapshots, penalties |
| TKB | weeks, tasks, subtasks, templates, recurrences (dương/âm), sessions (pomodoro thật), checklists |
| Giám sát | focus\_events (sự kiện cứng/mềm, không ảnh), reasons, fault\_points, appeals, breaks |
| Bot | persona\_versions, memories (+ vector), conversations, summaries, messages (hộp thư) |
| Hệ thống | audit\_log, jobs, sheet\_links, calendar\_links |

**Cơ chế code chính**

1. **Vòng là máy trạng thái:** Nháp, Chờ chuyển tiền, Đang chạy, Chốt sổ, Đã đóng. Chỉ chuyển sang Đang chạy khi mọi ngân hàng đã có biên lai đủ tiền.
2. **Đường ống biên lai:** job đọc email, parser tự học theo mẫu (xem Cơ chế xử lý biên lai lạ), khử trùng theo số lệnh, đối chiếu theo thứ tự 4 bước, ghi kết quả vào sổ. Không khớp thì đưa vào hộp thư Bất thường.
3. **Đường ống giám sát:** trình duyệt gửi heartbeat 10–15 giây một lần và các sự kiện đã lọc. Server tự phát hiện mất heartbeat (trình duyệt không thể tự báo khi đã bị đóng). Mỗi sự kiện cứng mở một "phiếu hỏi lý do" có hạn trả lời.
4. **Bộ luật tính điểm:** hàm thuần, đầu vào là sự kiện, lý do và cấu hình của người dùng, đầu ra là điểm. Chạy lại được khi kháng cáo, và có unit test cho từng luật.
5. **Scheduler:** nhắc giờ, push hết task, hỏi TKB cuối tuần, mở vòng, giải quyết mục quá 24h. Tất cả là job hẹn giờ theo múi giờ từng người.
6. **Agent loop:** mỗi tin nhắn được ghép persona, trí nhớ liên quan và trạng thái hiện tại, rồi gửi cho model kèm bộ tool. Mọi thay đổi dữ liệu đi qua tool, được ghi audit, và việc quan trọng phải có nút xác nhận.
7. **Đồng bộ một chiều:** database đẩy sang Sheet và Google Calendar. Sửa chỉ trên web (hoặc qua bot), nên không bao giờ lệch hai nguồn.

**Bảo mật và quyền riêng tư**

- Nhóm dưới 100 người: đăng ký bằng lời mời, đăng nhập Google hoặc magic link.
- Cách ly dữ liệu theo người (row-level security trong PostgreSQL).
- Mã hoá API key và OAuth token khi lưu. Bot chỉ nhận thư ngân hàng do người dùng tự chuyển tiếp, không truy cập hộp thư của họ.
- Xin đồng ý riêng cho camera, email và ngân hàng. Không lưu ảnh. Người dùng tải về hoặc xoá được toàn bộ dữ liệu của mình.
- Sao lưu database hằng ngày ra ngoài server.

**Lộ trình đề xuất**

Mục tiêu: có **bản demo đủ mọi tính năng, mỏng nhưng chạy thật từ đầu đến cuối**, rồi mới làm dày. Cách làm tối ưu cho vibe coding với Claude Code:

1. **P0 – Khung (làm kỹ nhất, một lần):**
   - Chuyển tài liệu này thành `CLAUDE.md` gốc và một `CLAUDE.md` cho mỗi service.
   - Viết package `contracts` (mọi API, sự kiện, enum).
   - Docker Compose, gateway + đăng nhập, 10 service rỗng có health check, CI chạy lint + test.
   - Mọi session sau đều bám vào khung này, nên sai ở đây là tốn nhất.
2. **P1 – Ba luồng song song** (sau khi contracts đã khóa, mỗi luồng một session/worktree riêng):
   - **Luồng tiền:** ingest + budget + rules (phần vượt chi). Test bằng email thật của bạn đã ẩn thông tin.
   - **Luồng thời gian:** schedule + FE checklist/đồng hồ + web push.
   - **Luồng giao tiếp:** notify (Telegram, Discord) + ai (BYOK, persona, trí nhớ, tool).
3. **P2 – Giám sát:** monitor + MediaPipe trên FE + rules (sổ lỗi, mốc phạt, kháng cáo).
4. **P3 – Nối dây và đồng bộ:** sync (Sheet, Calendar), lịch âm, QR, hộp thư trên web. Chạy một kịch bản end-to-end: mở vòng → chi tiêu → vượt chi → phạt → nộp phạt → xác minh.
5. **P4 – Demo:** dữ liệu mẫu, deploy HTTPS trên server của bạn, bạn tự dùng 1–2 tuần, rồi mời 3–5 người dùng thử kèm nút report lỗi trong web.

Mẹo tiết kiệm thời gian và hạn mức Claude:

- **Mỗi session một việc nhỏ:** một service hoặc một luồng, bắt đầu bằng plan mode, kết thúc bằng test xanh và commit.
- **Test trước cho phần luật:** luật tiền và phạt là hàm thuần, viết test từ bảng ví dụ trước rồi để Claude code cho qua test. Đây là chỗ bug đắt nhất.
- **Fixture email thật:** gom 20–30 email ngân hàng của bạn (đã ẩn số tài khoản) làm bộ test cho ingest.
- **Không tối ưu sớm:** chưa cần Kubernetes, chưa cần tách DB, chưa cần Zalo.

**Còn mở**

- Người dùng không cần cung cấp mẫu biên lai nữa (bot tự học). Cần test DKIM sau khi chuyển tiếp với từng ngân hàng thật.
- Mua tên miền và cấu hình Cloudflare theo phần Hạ tầng.

## Mô hình vibe coding với Claude Max

Bạn là chủ sản phẩm và người duyệt, Claude Code là đội thợ. Spec và hợp đồng viết trước, mỗi việc là một issue nhỏ, mỗi issue chạy trong một session và một worktree riêng, còn test và CI làm người gác cổng. Demo nhanh nhất khi dựng **bộ xương chạy xuyên suốt 4 kịch bản** trước, rồi mới làm dày.

**Bốn kịch bản demo (phạm vi đóng băng)**

1. **Người mới:** đăng nhập, tour, hỏi đáp, nhận TKB mẫu và ngân sách mẫu, ký bản cam kết.
2. **Tiền:** mở vòng, nạp tiền bằng QR và biên lai, chi có mã, chi lạ, thẻ quốc tế, vượt chi, phạt treo, nộp phạt.
3. **Thời gian:** checklist ngày, đồng hồ đếm giây, giám sát camera, tin khẩn và lý do, điểm lỗi, review tuần.
4. **Sinh hoạt:** nhắc ngủ, ảnh dậy có thử thách, ghi nhận hai bên.

Mọi ý tưởng ngoài 4 kịch bản này vào backlog (issue gắn nhãn `backlog`), không chen vào giữa chừng.

**Ba nguyên tắc**

1. **Spec trước, code sau:** tài liệu này được tách thành `docs/spec/<miền>.md`. Mỗi issue trích đúng đoạn spec và có tiêu chí nghiệm thu dạng Cho / Khi / Thì.
2. **Lát cắt dọc:** mỗi issue đi xuyên FE, gateway, service và DB cho một hành vi nhìn thấy được. Không làm xong hết backend rồi mới đến FE.
3. **Máy gác cổng:** typecheck, test và kiểm tra contracts chạy tự động. Agent tự merge khi mọi cổng xanh; bạn chỉ nghiệm thu cuối.

**Bộ đồ nghề trong repo (dựng ở P0)**

| Thứ | Dùng để |
| --- | --- |
| `CLAUDE.md` gốc và mỗi service | Stack, lệnh build/test, định nghĩa "xong", điều cấm. Claude đọc ở đầu mỗi session, nên giữ ngắn |
| Hooks | Sau mỗi lần sửa file thì chạy typecheck và test của package bị ảnh hưởng. Chặn sửa `packages/contracts` và `.env` ngoài issue cho phép. `CLAUDE.md` chỉ là hướng dẫn; điều phải chặn tuyệt đối thì đặt vào hook ([tài liệu](https://code.claude.com/docs/en/memory)) |
| Skills (lệnh riêng) | `/new-service` sinh service từ khuôn, `/implement-issue`, `/review-pr`, `/e2e-demo` chạy lại 4 kịch bản |
| Subagent reviewer chỉ đọc | Review trong ngữ cảnh riêng, không thấy quá trình viết code, nên không tự chấm bài mình |
| Khuôn service | 10 service chung một khung (Fastify, health check, log, kết nối NATS, test) |
| Seed, fixture email, giả lập thời gian | Dựng lại trạng thái demo bằng một lệnh, tua tuần và vòng để thử |
| GitHub Action của Claude | Gắn `@claude` trong PR để review hoặc sửa nhỏ. Cần cấu hình đăng nhập riêng ([tài liệu](https://code.claude.com/docs/en/github-actions)) |

**Vòng lặp cho mỗi issue**

1. Kiến trúc sư soạn issue từ spec, có tiêu chí nghiệm thu và phụ thuộc.
2. Điều phối phát issue cho một thợ, thợ làm trong worktree riêng ([tài liệu](https://code.claude.com/docs/en/common-workflows)).
3. Thợ viết test theo tiêu chí nghiệm thu, rồi code đến khi test xanh.
4. Reviewer và các cổng tự động chạy trên PR.
5. Qua hết cổng thì hàng đợi merge tự squash merge.
6. Lỗi lặp lại lần hai thì kiến trúc sư thêm một dòng luật vào `CLAUDE.md` để không tái diễn.

Chi tiết các vai, phân quyền và rào chắn nằm ở mục "Nhà máy tự vận hành" bên dưới.

**Chạy song song**

- **P0 chạy một session, tuần tự.** Khung sai thì mọi thứ sau đều sai.
- **Từ P1 chạy 3 worktree** theo 3 luồng tiền, thời gian, giao tiếp. Hướng dẫn của Claude Code gợi ý 3–5 session song song ([mẹo dùng](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips)).
- **Luật tránh đụng nhau:** hai session không sửa cùng một service. Contracts chỉ đổi qua một PR riêng, merge trước rồi các luồng mới kéo về.
- **Việc dài không cần trông:** giao cho session chạy nền, quay lại khi nó báo xong hoặc cần bạn.

**Dùng hạn mức Max cho khéo**

- Max có giới hạn theo phiên 5 giờ và theo tuần, dùng chung giữa Claude và Claude Code. Model mạnh nhất có giới hạn tuần riêng ([Max](https://support.claude.com/en/articles/11049741-what-is-the-max-plan), [bảng giá](https://claude.com/pricing)).
- Đã chốt: mọi agent code đều dùng Sonnet, nên không đụng vào giới hạn riêng của model mạnh nhất. Bù lại, issue phải nhỏ hơn, spec chi tiết hơn, test viết trước, và subagent reviewer chấm theo một checklist cố định. Lệnh `/usage` cho xem mức đã dùng.
- Một issue một session. Việc tra cứu và đọc log giao cho subagent để ngữ cảnh chính gọn.
- Gói Max có tín dụng API hằng tháng cho Claude Platform, không dùng được cho Claude Code ([chi tiết](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)). Có thể lấy nó làm API key của chính bạn để chạy bot My Wife lúc dev và demo.

**Phạm vi: làm tất cả, không cắt** (đã chốt)

- **Trong bản demo:** 4 kịch bản, cả Telegram lẫn Discord, parser biên lai tự học, đồng bộ Sheet và Calendar, lịch âm, khởi tạo và hướng dẫn người mới, trang quản trị.
- **Thứ tự vẫn giữ:** bộ xương đường đi thuận trước, rồi làm dày. Thứ tự không cắt gì, nó chỉ giúp bạn có thứ bấm thử được sớm.
- **Vẫn để sau demo:** các ý tưởng ghi "Sau demo" trong phần Rủi ro (bạn đồng hành, chống giả camera, đọc lịch có sẵn, ngày xấu, báo cáo vòng, tin nhắn thoại) và Zalo.
- **Vận hành:** 10 service giữ nguyên ranh giới nhưng chạy bằng một lệnh, không dùng Kubernetes.

**Thứ tự các đợt:** P0 khung → bộ xương 4 kịch bản (chỉ đường đi thuận) → làm dày từng kịch bản (lỗi, kháng cáo, phạt treo, parser tự học) → deploy demo và tự dùng. Mỗi đợt xong khi `/e2e-demo` chạy qua bằng giả lập thời gian.

**Ước tính thời gian** (ước lượng của Claude, chưa đo thực tế)

Cơ sở tính là số đo thật của bạn ở dự án khác: **10–15 issue merge trong 4 giờ**, tức 2,5–3,75 issue mỗi giờ. Khối lượng khoảng 160 issue, cộng 30% cho issue sửa lỗi phát sinh, thành khoảng 210. Giả định còn lại: issue ở đây cùng cỡ với issue của dự án kia.

| Gói việc | Số issue ước tính |
| --- | --- |
| P0 khung (monorepo, contracts, khuôn service, gateway, CI/CD, giả lập thời gian) | 15 |
| Tiền (vòng, mục, biên lai, parser tự học, sổ nợ, QR, đối soát) | 38 |
| Thời gian (TKB, đồng hồ, lịch âm, nhịp sinh hoạt, Calendar) | 30 |
| Giao tiếp và AI (Telegram, Discord, hộp thư, BYOK, persona, trí nhớ, ảnh dậy) | 27 |
| Giám sát và luật (camera, heartbeat, sổ lỗi, phạt treo, cam kết, kháng cáo) | 22 |
| Khởi tạo, Sheet, quản trị | 15 |
| Nối dây, chạy 4 kịch bản, sửa lỗi, deploy | 13 |

Với tốc độ đó, thời gian viết code không còn là vấn đề. Thứ quyết định ngày demo là **hạn mức tuần của gói Max**.

| Bước tính | Kết quả |
| --- | --- |
| Tổng giờ agent nếu chạy một luồng | 210 ÷ (2,5–3,75) = 56–84 giờ |
| Chạy 24/7 với 3 luồng, không vướng hạn mức | Khoảng 1–1,5 ngày, cộng P0 tuần tự 4–6 giờ |
| Chỉ tính giới hạn 5 giờ, giả định xấu nhất là phiên 4 giờ của bạn đã dùng hết một cửa sổ | 10–15 issue mỗi cửa sổ, 48–72 issue mỗi ngày, xong trong 3–4,5 ngày |
| Số "khối 4 giờ" cần cho cả dự án | 210 ÷ 12,5 ≈ 17 khối (14–21) |
| Nghiệm thu thật của bạn ở cuối | 1–2 ngày |

| Một khối 4 giờ tiêu bao nhiêu hạn mức tuần | Số tuần hạn mức cần (17 khối) | Demo sau khoảng |
| --- | --- | --- |
| 3% | 0,5 | 5–7 ngày |
| 6% | 1 | 7–9 ngày |
| 10% | 1,7 | 10–14 ngày |
| 15% | 2,5 | 2,5–3 tuần |

Tức là demo có sau **khoảng 1 tuần nếu hạn mức tuần đủ, và 2–3 tuần nếu không đủ**.

Con số duy nhất còn thiếu là cột đầu của bảng trên. Bạn đọc được nó bằng `/usage` trước và sau một phiên 4 giờ như bạn vẫn làm. Anthropic không công bố hạn mức Max theo số giờ, nên không tra được ở đâu khác. Nếu hạn mức tuần không đủ, gói Ultra có hạn mức tuần gấp đôi Max và không có giới hạn 5 giờ ([bảng giá](https://claude.com/pricing)).

Hai điều có thể làm chậm hơn phép tính: khi không có bạn trong vòng lặp, cổng kiểm tra tự động chạy lâu hơn một lần bấm thử; và 3 luồng song song sinh xung đột khi merge.

**Nhà máy tự vận hành: một lệnh duy nhất** (đã chốt, thay cho vòng lặp duyệt tay)

Bạn chạm vào hệ thống đúng ba lúc: bàn giao một lần lúc đầu, trả lời khi agent hỏi vượt quyền, và nghiệm thu cuối. Mọi việc khác agent tự làm, tự thảo luận, tự merge.

**Bàn giao một lần** (trước khi gõ lệnh)

- Spec đóng băng: tài liệu này, tách thành `docs/spec/`.
- Một file cấu hình bí mật cho môi trường demo: tên miền và token Cloudflare, token bot Telegram và Discord, OAuth client của Google (Sheets, Calendar), API key LLM.
- GitHub: org, repo, một GitHub App cho agent với quyền đã giới hạn.
- Server có Docker và Claude Code đã đăng nhập bằng gói Max, mặc định model Sonnet.

Sau đó bạn điều khiển bằng 4 lệnh: `./factory run` (bắt đầu hoặc chạy tiếp), `./factory stop` (dừng), `./factory status` (xem việc và trả lời câu hỏi), `./factory log` (theo dõi tiến độ).

**Các vai trong nhà máy**

| Vai | Là gì | Việc |
| --- | --- | --- |
| Điều phối | Script thường, không phải LLM | Đọc đồ thị issue, phát việc theo phụ thuộc, giới hạn số luồng, thử lại, canh hạn mức |
| Kiến trúc sư | Agent Sonnet | Biến spec thành đồ thị issue có tiêu chí nghiệm thu. Giữ `contracts`, viết ADR, phân xử tranh cãi |
| Đại diện chủ sản phẩm | Agent Sonnet | Trả lời câu hỏi của thợ dựa trên spec và sổ quyết định. Quyết trong quyền, vượt quyền thì hỏi bạn |
| Thợ (nhiều) | Agent Sonnet, mỗi issue một worktree | Viết test theo tiêu chí, code đến khi xanh, mở PR |
| Reviewer | Agent Sonnet, ngữ cảnh mới, chỉ đọc | Chấm PR theo checklist cố định, yêu cầu sửa |
| QA | Agent Sonnet | Viết và chạy bộ kiểm tra 4 kịch bản, mở issue lỗi |
| Hàng đợi merge | Tính năng của GitHub | Tự merge khi mọi cổng xanh |

**Agent thảo luận với nhau thế nào**

- Mọi trao đổi nằm trong comment của issue và PR trên GitHub, nên bạn đọc lại được bất cứ lúc nào.
- Thợ hỏi trong issue, đại diện chủ sản phẩm hoặc kiến trúc sư trả lời.
- Thợ và reviewer tranh luận tối đa 2 vòng. Chưa xong thì kiến trúc sư phân xử. Vẫn chưa xong thì mới đến bạn.
- Quyết định nào không có trong spec đều được ghi một dòng vào `docs/decisions.md`. Bạn có thể phủ quyết sau; vì PR nhỏ nên đảo lại rẻ.

**Cổng tự động thay cho việc bạn bấm thử**

1. Lint, typecheck, unit test, kiểm tra `contracts`.
2. Test theo bảng ví dụ cho luật tiền và phạt, lấy từ spec. Đây là phần không được sai.
3. Reviewer đồng ý.
4. Bộ 4 kịch bản chạy trong trình duyệt thật bằng Playwright trên môi trường xem trước: camera giả phát video mẫu, email là fixture gửi vào webhook, Telegram và Discord là máy chủ giả lập, thời gian được tua.
5. Qua cả 4 thì tự merge. Bộ kịch bản đỏ trên `main` thì nhà máy dừng phát việc mới và dồn lực sửa.

**Phân quyền quyết định**

| Ai quyết | Loại việc |
| --- | --- |
| Thợ tự quyết | Cách cài đặt, đặt tên, refactor, thiết kế test, bố cục giao diện trong bộ thiết kế chung, sửa lỗi |
| Đại diện chủ sản phẩm quyết, có ghi sổ | Spec thiếu hoặc mơ hồ nhưng có lựa chọn an toàn và đảo lại được; câu chữ, giá trị mặc định |
| Kiến trúc sư quyết, có ADR | Đổi `contracts`, thêm thư viện, đổi schema, thay đổi chạm nhiều service |
| Phải hỏi bạn | Xem danh sách dưới |

Agent chỉ hỏi bạn trong 6 trường hợp:

1. **Cần tiền, tài khoản hoặc bí mật mới:** mua dịch vụ, tạo tài khoản, thiếu token.
2. **Đổi luật sản phẩm đã chốt:** luật tiền, luật phạt, mức giám sát.
3. **Quyền riêng tư và pháp lý:** lưu ảnh, gửi dữ liệu người dùng ra bên ngoài, đổi nội dung xin đồng ý.
4. **Việc không đảo lại được:** xoá dữ liệu, đổi quyền repo, đưa lên môi trường có người dùng thật.
5. **Spec mâu thuẫn** mà không có lựa chọn an toàn.
6. **Kẹt:** một issue trượt quá N lần, bộ kịch bản đỏ quá X giờ, hoặc hạn mức cạn sớm hơn kế hoạch.

Câu hỏi được lưu thành file và hiện trong lệnh `status`, kèm các lựa chọn và đề xuất của agent. Bạn trả lời ngay trong CLI. Việc liên quan được gác lại, nhà máy vẫn làm việc khác trong lúc chờ.

**Rào chắn khi agent tự merge**

- **Cách ly:** agent chạy trong container hoặc VM, không phải root ([tài liệu](https://code.claude.com/docs/en/sandbox-environments)). Chúng chỉ có bí mật của môi trường demo, không có email ngân hàng thật.
- **Quyền GitHub:** agent chỉ đưa code vào `main` qua hàng đợi merge. Không đẩy thẳng, không force push, không sửa luật bảo vệ nhánh, không sửa workflow CI nếu không có ADR.
- **Không tự nới cổng:** xóa hoặc bỏ qua test để cho xanh bị hook chặn và bị reviewer từ chối.
- **Canh hạn mức:** điều phối rải việc theo hạn mức tuần và giữ lại một phần cho việc sửa lỗi cuối. Chạm giới hạn 5 giờ thì tự chờ rồi chạy tiếp.
- **Báo cáo:** lệnh status và log cho xem số issue merge, phần trăm hạn mức đã dùng, các quyết định mới trong sổ, việc đang chờ bạn.

**Nghiệm thu cuối** là việc không giao được cho agent: bạn chạy 4 kịch bản trên máy và điện thoại thật, với camera thật, email ngân hàng thật, Telegram và Discord thật, và quyết định đây có đúng là thứ bạn muốn không.

**Mốc bàn giao** (bạn chọn mốc nào nhà máy dừng lại chờ bạn xem; mặc định M1 và M4)

| Mốc | Nội dung |
| --- | --- |
| M0 | Rà spec, dựng khung, sinh toàn bộ danh sách issue |
| M1 | Bộ xương 4 kịch bản, đường đi thuận. Bản demo đầu tiên |
| M2 | Tiền đầy đủ |
| M3 | Thời gian và giám sát đầy đủ |
| M4 | Sinh hoạt, AI, khởi tạo, quản trị, deploy. Bản demo đầy đủ |

**Model cho từng agent** (mặc định tất cả là Sonnet; phần trăm là ước lượng khối lượng, chưa đo)

| Agent | Khối lượng | Độ khó | Đề xuất |
| --- | --- | --- | --- |
| Thợ service (CRUD, adapter, đồng bộ) | \~21% | Vừa | Sonnet |
| Thợ lõi (luật tiền, phạt, biên lai) | \~19% | Cao | Sonnet; nâng lên Opus nếu tỉ lệ làm lại cao |
| Thợ web (giao diện) | \~19% | Vừa | Sonnet |
| Reviewer | \~9% | Cao, chỉ đọc diff | Ưu tiên nâng thứ hai: Opus |
| Điều phối chính | \~8% | Vừa | Sonnet |
| Thợ real-time (đồng hồ, camera) | \~7% | Cao | Sonnet; nâng khi kẹt |
| QA | \~7% | Vừa | Sonnet |
| Kiến trúc sư | \~6% | Cao nhất | Ưu tiên nâng thứ nhất: Opus |
| Đại diện chủ sản phẩm | \~2% | Vừa | Sonnet |
| Rà spec | \~1% | Cao, làm ít lần | Opus |
| Ghi chép (báo cáo, bàn giao) | \~1% | Thấp | Haiku |

**Lấy API key từ tín dụng API của gói Max** ([hướng dẫn](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans), [tài liệu](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers))

1. **Điều kiện:** gói Max đang hoạt động và đã đăng ký đủ 7 ngày. Phải nhận trên claude.ai bằng trình duyệt web. Không cần thêm thẻ thanh toán.
2. **Mở trang thanh toán:** trên claude.ai vào Settings > Billing, tìm mục API credits.
3. **Liên kết tổ chức Console:** chọn liên kết, rồi chọn một tổ chức trên platform.claude.com hoặc tạo mới ngay trong luồng này. Đăng nhập Console bằng cùng email với claude.ai. Đọc điều khoản và xác nhận.
4. **Kiểm tra:** vào trang Billing của Console, tín dụng hiện ở mục Promotional credits kèm ngày hết hạn.
5. **Tạo key:** tạo API key trong chính tổ chức đó. Mọi key của tổ chức này đều tiêu chung số dư tín dụng.

Lưu ý khi dùng:

- **Chọn tổ chức cẩn thận:** mỗi gói chỉ liên kết một tổ chức và bạn không tự đổi được, muốn đổi phải liên hệ hỗ trợ.
- **Không cộng dồn:** tín dụng làm mới mỗi kỳ thanh toán, phần chưa dùng hết hạn cuối kỳ.
- **Hết tín dụng:** request bị dừng đến kỳ sau, trừ khi bạn mua thêm. Gói Max không bị tính tiền thêm. Bot phải xử lý được trường hợp này (xem "Chạy khi LLM lỗi").
- **Tách ngân sách:** tạo một workspace riêng cho My Wife và đặt giới hạn chi, để dự án khác không ăn hết số dư.
- **Chỉ dùng cho tài khoản của bạn:** bạn bè vẫn mang key riêng, vì số dư là chung và hạng giới hạn tốc độ của tổ chức này ở mức khởi đầu.
- **Không dùng cho Claude Code tương tác:** việc vibe coding vẫn chạy bằng hạn mức của gói Max.

## Rủi ro và điểm chưa đạt

Rủi ro lớn nhất nằm ở **dữ liệu đầu vào tiền bạc** (thiếu hoặc giả biên lai) và **phạt oan** khi hệ thống lỗi, không nằm ở code.

| Rủi ro | Mức | Cách giảm |
| --- | --- | --- |
| Chi bằng tiền mặt, tài khoản không khai báo, hoặc ngân hàng không gửi email | Cao | Đối soát số dư hằng tuần. Rút tiền mặt phải phân bổ vào mục. Ngân hàng không email thì không được giữ mục |
| Email biên lai giả để "nộp phạt" | Cao | Chỉ nhận thư có DKIM hợp lệ của domain ngân hàng, cộng đối soát số dư tài khoản phạt |
| LLM đọc sai số tiền | Cao | Số phải xuất hiện nguyên văn trong email, kiểm số dư, LLM không được tự ghi sổ |
| Server hoặc mạng sập, bị tính mất heartbeat | Cao | Server tự ghi lịch sử hoạt động. Khi server hoặc toàn bộ mạng có sự cố, lỗi trong khoảng đó tự được miễn |
| Microservice quá nặng cho một người vibe code | Trung bình | Monorepo, contracts chung, một DB, một Compose. Môi trường dev có thể chạy nhiều service chung một process |
| Claude sinh code lệch nhau giữa các session | Trung bình | Contracts khóa, CLAUDE.md mỗi service, CI bắt buộc test xanh trước khi merge |
| Dữ liệu tài chính và khuôn mặt của bạn bè nằm trên server cá nhân | Trung bình | Không lưu ảnh, mã hoá key, đồng ý riêng từng mục, cho tải về và xoá dữ liệu. Nên hỏi luật sư trước khi mở rộng |
| Người dùng bỏ cuộc vì bị phạt quá nặng ngay từ tuần đầu | Trung bình | Chế độ thử với phạt treo: tính như thật, miễn lỗi do hệ thống, cuối kỳ vẫn thu phạt (xem Tính năng 2) |
| Chi phí LLM của người dùng tăng bất ngờ | Thấp | Hạn mức token mỗi ngày do người dùng đặt, parser thay LLM cho mẫu đã quen |
| Camera tốn pin, nóng máy | Thấp | 2–5 khung hình/giây, dừng khi nghỉ, máy yếu thì giảm thêm |

**Điểm chưa đạt, cần chốt thêm**

- **Trang quản trị cho bạn:** quản lý lời mời, xem lỗi hệ thống, khai báo sự cố để miễn lỗi hàng loạt, bật tắt tính năng cho từng người.

Đã chốt và đưa vào các phần trên: thu nhập, nợ và chi chung nhóm (cơ chế biên lai lạ), hướng dẫn lúc đăng ký (phần Khởi tạo).

**Bổ sung sau rà soát toàn bộ**

| Còn thiếu | Đề xuất | Khi nào làm |
| --- | --- | --- |
| Bản cam kết giữa người dùng và bot | Mỗi vòng có một trang tóm tắt toàn bộ luật đang áp dụng (ngân sách, giờ giám sát, mốc phạt, nhịp sinh hoạt). Người dùng bấm ký, bản ký có phiên bản và không sửa được | Demo |
| Khoá nới lỏng luật | Siết luật thì có hiệu lực ngay. Nới lỏng (giảm phạt, bớt giờ giám sát, tắt cam kết) chỉ có hiệu lực từ tuần hoặc vòng sau, để không ai tự tha cho mình lúc đang yếu lòng | Demo |
| Task ngoài máy tính (họp, đi học, tập) | Hồ sơ task "ngoại tuyến": không cần mở web, check-in lúc bắt đầu và kết thúc qua chat, tuỳ chọn ảnh có thử thách như ảnh dậy | Demo |
| Thiết bị giám sát | Mỗi lúc chỉ một phiên giám sát. Trình duyệt điện thoại không giữ tab nền ổn định, nên giám sát camera yêu cầu máy tính; điện thoại dùng checklist, đồng hồ và chat | Demo |
| Chạy khi LLM lỗi | Key hết tiền hoặc nhà cung cấp sập thì đồng hồ, luật, phạt, parser đã học và các nút bấm vẫn chạy. Bot báo người dùng và chuyển sang model phụ | Demo |
| Email là dữ liệu không tin cậy | Thư có thể chứa chữ giả làm mệnh lệnh. LLM đọc biên lai không được gọi tool, chỉ trả về các trường có cấu trúc, và mọi trường phải qua bước kiểm chứng | Demo |
| Giả lập thời gian | Chế độ tua nhanh tuần và vòng để thử mở vòng, chốt sổ, phạt treo mà không phải chờ thật. Cần cho cả lúc code lẫn lúc demo | P0 |
| Thưởng | Chuỗi ngày sạch lỗi, mở khoá một khoản trong mục Muốn hoặc trích từ quỹ phạt khi đạt mốc, do người dùng đặt | Demo (bản đơn giản) |
| Bạn đồng hành | Tuỳ chọn mời một người bạn trong nhóm xem báo cáo tuần và nhận tin khi mình bị phạt | Sau demo |
| Chống giả camera | Ảnh hoặc video đặt trước webcam có thể qua mặt máy. Thỉnh thoảng thêm thử thách ngẫu nhiên (chớp mắt, quay đầu) | Sau demo |
| Thực đơn và danh sách mua tuần | Có trong Sheet nhưng thiếu trong tài liệu này, đã bổ sung vào Tính năng 1 | Demo |

**Luật tiền phạt (đã chốt): tiết kiệm bắt buộc**

- **Tài khoản riêng:** tiền phạt vào một tài khoản "tiết kiệm phạt", tách khỏi mục Tiết kiệm thường. Nó không được tính vào khoản tiết kiệm cố định hay phần x% dư, vì nếu tính thì phạt không còn tốn gì.
- **Không được tiêu:** mọi khoản tiền ra khỏi tài khoản này là vi phạm nặng. Người dùng phải nộp lại đủ và chịu phạt thêm theo tỉ lệ đã đặt. Bot phát hiện bằng biên lai và đối soát số dư hằng tuần.
- **Nhờ ngân hàng khoá hộ:** nên dùng loại tài khoản tiết kiệm có kỳ hạn của ngân hàng, nếu có, để việc rút sớm vốn đã khó.
- **Mở khoá:** chỉ theo điều kiện ghi trong bản cam kết, ví dụ ngày đáo hạn hoặc một mục tiêu dài hạn. Đổi điều kiện này tuân theo luật khoá nới lỏng.
- **Nguồn tiền phạt giám sát và sinh hoạt:** trừ vào hạn mức các mục nhãn Muốn theo thứ tự người dùng đặt, không bao giờ trừ mục Cần. Phạt vượt chi vẫn trừ vào chính mục bị vượt như đã chốt.
- **Trần phạt:** mỗi tuần có mức tối đa do người dùng đặt. Phần vượt trần dồn sang tuần sau thành nợ phạt, không mất đi.

**Rà soát lần hai: chỗ chưa khớp, đã vá**

- **Một định nghĩa tuần:** tuần của TKB và tuần của ngân sách dùng chung ngày bắt đầu, do người dùng đặt.
- **Giờ yên lặng:** chỉ tin dậy và tin khẩn được gửi trong giờ yên lặng. Mọi tin khác chờ đến sáng.
- **Ngân sách tin nhắn:** tin thường gộp thành một bản tin sáng (TKB hôm nay, hạn mức còn lại, nợ đến hạn) và một bản tin tối. Tin lẻ chỉ dành cho việc đúng giờ hoặc cần trả lời.
- **Ốm bật hồi tố:** chế độ ốm có thể bật lại cho 24h vừa qua, kèm lý do và trong hạn mức.
- **Tiền phạt giám sát lấy từ đâu:** đã ghi trong luật tiền phạt ở trên.

**Ý tưởng mới**

| Ý tưởng | Mô tả | Khi nào |
| --- | --- | --- |
| Ghi nhanh qua chat | Nhắn "mua sữa 35k tiền mặt" hoặc "thêm task gọi cho mẹ tối nay", bot ghi vào đúng chỗ. Đây cũng là cách khai chi tiền mặt | Demo |
| Mức nghiêm khắc của bot | Một thanh chỉnh giọng từ dịu đến nghiêm trong hồ sơ nhân vật | Demo |
| Bản tin sáng và tối | Như mục ngân sách tin nhắn ở trên | Demo |
| Đọc lịch có sẵn | Lấy sự kiện từ Google Calendar làm khối bận, chỉ đọc, để xếp task tránh giờ họp | Sau demo |
| Hoá đơn và gói đăng ký | Tự tạo task nhắc trước ngày đến hạn hoặc gia hạn | Sau demo |
| Ngày xấu | Một chạm để giảm tải còn một việc chính, có hạn mức mỗi vòng | Sau demo |
| Báo cáo vòng | Tổng kết tiền, thời gian và thói quen của cả vòng | Sau demo |
| Tin nhắn thoại | Nói thay vì gõ khi ghi nhanh | Sau demo |
